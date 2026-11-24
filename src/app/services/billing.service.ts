import { Injectable, signal, computed, effect } from '@angular/core';
import { FlatSubscription, CalculatedFlat, DayStatus, DayBreakdown, DayHeader } from '../models/delivery.model';

const STORAGE_KEYS = {
  SUBSCRIPTIONS: 'jsm_billing_subscriptions_v2',
  RATES: 'jsm_billing_rates_v2',
  MONTH: 'jsm_billing_month_v2'
};

@Injectable({ providedIn: 'root' })
export class BillingService {
  billingMonth = signal<string>(this.loadInitialMonth());
  rates = signal<Record<string, number>>(this.loadInitialRates());

  daysHeader = computed<DayHeader[]>(() => {
    const [yearStr, monthStr] = this.billingMonth().split('-');
    const year = Number(yearStr) || new Date().getFullYear();
    const monthIndex = (Number(monthStr) || (new Date().getMonth() + 1)) - 1;
    const totalDays = new Date(year, monthIndex + 1, 0).getDate();

    return Array.from({ length: totalDays }, (_, i) => {
      const d = new Date(year, monthIndex, i + 1);
      const dow = d.getDay();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(i + 1).padStart(2, '0');
      return {
        dayNum: i + 1,
        dateStr: `${yyyy}-${mm}-${dd}`,
        weekday: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayOfWeek: dow,
        isWeekend: dow === 0 || dow === 6
      };
    });
  });

  private rawSubscriptions = signal<FlatSubscription[]>(this.loadInitialSubscriptions());

  selectedSociety = signal<string>('ALL');
  searchQuery = signal<string>('');
  lastSavedAt = signal<string>('Synced with browser storage');

  constructor() {
    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEYS.SUBSCRIPTIONS, JSON.stringify(this.rawSubscriptions()));
        this.stampSaved();
      } catch (e) {
        console.warn('Storage error:', e);
      }
    });

    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEYS.RATES, JSON.stringify(this.rates()));
        this.stampSaved();
      } catch (e) {
        console.warn('Storage error:', e);
      }
    });

    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEYS.MONTH, this.billingMonth());
      } catch (e) {
        console.warn('Storage error:', e);
      }
    });
  }

  private stampSaved() {
    const now = new Date();
    this.lastSavedAt.set(`Saved ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
  }

  formattedMonthLabel = computed(() => {
    const [yearStr, monthStr] = this.billingMonth().split('-');
    const date = new Date(Number(yearStr), Number(monthStr) - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  });

  societies = computed(() => {
    const unique = new Set(this.rawSubscriptions().map(s => s.society));
    return ['ALL', ...Array.from(unique)];
  });

  calculatedSubscriptions = computed<CalculatedFlat[]>(() => {
    const rateMap = this.rates();
    const societyFilter = this.selectedSociety();
    const query = this.searchQuery().toLowerCase();
    const headers = this.daysHeader();

    return this.rawSubscriptions()
      .filter(sub => societyFilter === 'ALL' || sub.society === societyFilter)
      .filter(sub =>
        sub.flatNo.toLowerCase().includes(query) ||
        sub.newspaper.toLowerCase().includes(query) ||
        sub.wing.toLowerCase().includes(query) ||
        sub.society.toLowerCase().includes(query)
      )
      .map(sub => {
        let daysPresent = 0;
        let daysAbsent = 0;
        let paperAmount = 0;
        const breakdown: DayBreakdown[] = [];

        const standardDailyRate = this.computeBaseComboRate(sub.newspaper, rateMap);
        const effectiveDailyRate = (sub.customDailyRate !== null && sub.customDailyRate !== undefined)
          ? sub.customDailyRate
          : standardDailyRate;

        headers.forEach((header, idx) => {
          const status: DayStatus = sub.dailyRecords[idx] ?? 'PRESENT';
          const { charge, isScheduled } = this.computeDailyCharge(
            sub.newspaper,
            header.dayOfWeek,
            status,
            rateMap,
            sub.customDailyRate
          );

          if (status === 'ABSENT' || status === 0) {
            daysAbsent++;
          } else {
            daysPresent++;
            paperAmount += charge;
          }

          breakdown.push({
            dayNum: header.dayNum,
            dateStr: header.dateStr,
            weekday: header.weekday,
            status,
            charge: (status === 'ABSENT' || status === 0) ? 0 : charge,
            isScheduledDay: isScheduled
          });
        });

        return {
          ...sub,
          daysPresent,
          daysAbsent,
          totalDays: headers.length,
          effectiveDailyRate,
          paperAmount,
          grandTotal: paperAmount + (Number(sub.deliveryCharge) || 0),
          breakdown
        };
      });
  });

  summaryStats = computed(() => {
    const list = this.calculatedSubscriptions();
    return {
      totalFlats: list.length,
      totalPresentDays: list.reduce((acc, item) => acc + item.daysPresent, 0),
      totalAbsentDays: list.reduce((acc, item) => acc + item.daysAbsent, 0),
      totalRevenue: list.reduce((acc, item) => acc + item.grandTotal, 0)
    };
  });

  updateFlatDailyRate(flatId: string, newRate: number | null) {
    this.rawSubscriptions.update(subs =>
      subs.map(sub => sub.id === flatId ? { ...sub, customDailyRate: newRate } : sub)
    );
  }

  updateFlatDeliveryCharge(flatId: string, charge: number) {
    this.rawSubscriptions.update(subs =>
      subs.map(sub => sub.id === flatId ? { ...sub, deliveryCharge: Number(charge) || 0 } : sub)
    );
  }

  updateFlatNewspaper(flatId: string, newspaper: string) {
    this.rawSubscriptions.update(subs =>
      subs.map(sub => sub.id === flatId ? { ...sub, newspaper, customDailyRate: null } : sub)
    );
  }
  bulkReplaceNewspaper(
    findText: string,
    replaceText: string,
    targetSociety: string = 'ALL',
    exactMatchOnly: boolean = false
  ): number {
    const query = findText.trim();
    if (!query) return 0;

    let updatedCount = 0;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');

    this.rawSubscriptions.update(subs =>
      subs.map(sub => {
        if (targetSociety !== 'ALL' && sub.society !== targetSociety) {
          return sub;
        }

        if (exactMatchOnly) {
          if (sub.newspaper.trim().toLowerCase() === query.toLowerCase()) {
            updatedCount++;
            return { ...sub, newspaper: replaceText.trim(), customDailyRate: null };
          }
          return sub;
        }

        if (regex.test(sub.newspaper)) {
          updatedCount++;
          const nextValue = sub.newspaper.replace(regex, replaceText.trim()).replace(/\s+/g, ' ').trim();
          return { ...sub, newspaper: nextValue, customDailyRate: null };
        }

        return sub;
      })
    );

    return updatedCount;
  }

  toggleDay(flatId: string, dayIndex: number) {
    this.rawSubscriptions.update(subs =>
      subs.map(sub => {
        if (sub.id !== flatId) return sub;
        const updatedDays = [...sub.dailyRecords];
        const current = updatedDays[dayIndex];
        updatedDays[dayIndex] = (current === 'ABSENT' || current === 0) ? 'PRESENT' : 'ABSENT';
        return { ...sub, dailyRecords: updatedDays };
      })
    );
  }
  setDayCustomRate(flatId: string, dayIndex: number, rawInput: string | number | null) {
    this.rawSubscriptions.update(subs =>
      subs.map(sub => {
        if (sub.id !== flatId) return sub;
        const updatedDays = [...sub.dailyRecords];
        if (rawInput === null || String(rawInput).trim() === '') {
          updatedDays[dayIndex] = 'PRESENT';
        } else {
          const parsed = Number(rawInput);
          if (!isNaN(parsed)) {
            updatedDays[dayIndex] = parsed <= 0 ? 'ABSENT' : parsed;
          }
        }
        return { ...sub, dailyRecords: updatedDays };
      })
    );
  }


  changeBillingMonth(newMonth: string) {
    if (!newMonth) return;
    this.billingMonth.set(newMonth);
    const targetDays = this.daysHeader().length;
    this.rawSubscriptions.update(subs =>
      subs.map(sub => {
        const records = [...sub.dailyRecords];
        while (records.length < targetDays) records.push('PRESENT');
        if (records.length > targetDays) records.length = targetDays;
        return { ...sub, dailyRecords: records };
      })
    );
  }

  addSubscription(newSub: Omit<FlatSubscription, 'id' | 'dailyRecords'>) {
    const totalDays = this.daysHeader().length;
    this.rawSubscriptions.update(list => [
      { ...newSub, id: crypto.randomUUID(), dailyRecords: Array(totalDays).fill('PRESENT') },
      ...list
    ]);
  }

  deleteSubscription(id: string) {
    this.rawSubscriptions.update(list => list.filter(s => s.id !== id));
  }

  updateRate(paperName: string, newRate: number) {
    this.rates.update(current => ({ ...current, [paperName]: Number(newRate) || 0 }));
  }

  addNewRate(paperName: string, rate: number) {
    const trimmed = paperName.trim();
    if (!trimmed) return;
    this.rates.update(current => ({ ...current, [trimmed]: Number(rate) || 0 }));
  }

  resetDemoData() {
    localStorage.removeItem(STORAGE_KEYS.SUBSCRIPTIONS);
    localStorage.removeItem(STORAGE_KEYS.RATES);
    localStorage.removeItem(STORAGE_KEYS.MONTH);
    this.billingMonth.set(this.getCurrentYearMonth());
    this.rates.set(this.getDefaultRates());
    this.rawSubscriptions.set(this.getDefaultSubscriptions());
  }
  private computeBaseComboRate(newspaperSpec: string, rateMap: Record<string, number>): number {
    const parts = newspaperSpec.split('+').map(p => p.trim()).filter(Boolean);
    return parts.reduce((sum, part) => {
      const basePaper = part.replace(/\([^)]+\)/g, '').trim();
      return sum + (rateMap[basePaper] ?? rateMap[part] ?? 6);
    }, 0);
  }

  private computeDailyCharge(
    newspaperSpec: string,
    dayOfWeek: number,
    status: DayStatus,
    rateMap: Record<string, number>,
    customDailyRate?: number | null
  ): { charge: number; isScheduled: boolean } {
    if (status === 'ABSENT' || status === 0) return { charge: 0, isScheduled: false };
    if (typeof status === 'number') return { charge: status, isScheduled: true };

    if (customDailyRate !== null && customDailyRate !== undefined) {
      return { charge: Number(customDailyRate), isScheduled: true };
    }

    const parts = newspaperSpec.split('+').map(p => p.trim()).filter(Boolean);
    let totalCharge = 0;
    let anyScheduledToday = false;

    for (const part of parts) {
      const scheduleMatch = part.match(/\(([^)]+)\)/);
      const basePaper = part.replace(/\([^)]+\)/g, '').trim();
      const rate = rateMap[basePaper] ?? rateMap[part] ?? 6;

      if (!scheduleMatch) {
        totalCharge += rate;
        anyScheduledToday = true;
      } else {
        const rule = scheduleMatch[1].toLowerCase();
        if (this.matchesScheduleRule(rule, dayOfWeek)) {
          totalCharge += rate;
          anyScheduledToday = true;
        }
      }
    }
    return { charge: totalCharge, isScheduled: anyScheduledToday };
  }

  private matchesScheduleRule(rule: string, dayOfWeek: number): boolean {
    if (rule.includes('fri to sun')) return dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0;
    if (rule.includes('sat and sun')) return dayOfWeek === 6 || dayOfWeek === 0;
    if (rule.includes('wed and sat')) return dayOfWeek === 3 || dayOfWeek === 6;
    if (rule.includes('sun')) return dayOfWeek === 0;
    return true;
  }

  private getCurrentYearMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  private loadInitialMonth(): string {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.MONTH);
      if (saved && /^\d{4}-\d{2}$/.test(saved)) return saved;
    } catch {}
    return this.getCurrentYearMonth();
  }

  private loadInitialRates(): Record<string, number> {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.RATES);
      if (saved) return JSON.parse(saved);
    } catch {}
    return this.getDefaultRates();
  }

  private loadInitialSubscriptions(): FlatSubscription[] {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SUBSCRIPTIONS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return this.getDefaultSubscriptions();
  }

  private getDefaultRates(): Record<string, number> {
    return {
      'T': 7, 'AS': 3, 'GR': 6, 'NBT': 6, 'HT': 7, 'MT': 6,
      'Loksatta': 6, 'Dainaik Bhaskar': 6, 'Business STD': 10,
      'Mint': 10, 'ECO': 8, 'Eco': 8, 'NB': 6, 'Wealth': 8,
      'Mirror': 5, 'Hindu': 10, 'Indian': 7, 'Indain': 7,
      'Navakal': 5, 'Patrika': 6, 'Mumbai Samachar': 6, 'Samna': 5,
      'Sandhayanand': 5, 'Ratnagiri': 5, 'Business Line': 10,
      'Vapyar': 6, 'Prataksha': 6, 'Pravashi': 6, 'Matrabhoomi': 6,
      'Divya Bhaskar / Chitralekha': 12, 'Chouffer': 5, 'Hindu JR': 5,
      'Free press': 6, 'Udayvani': 6, 'Prataylkal': 5, 'Lokmat': 6,
      'Mid day': 6, 'GR Mid day': 6, 'RD (Maz)': 8
    };
  }

  private getDefaultSubscriptions(): FlatSubscription[] {
    const totalDays = this.daysHeader().length;
    const make = (
      society: string,
      wing: string,
      flatNo: string,
      newspaper: string,
      overrides?: Record<number, DayStatus>
    ): FlatSubscription => {
      const dailyRecords: DayStatus[] = Array(totalDays).fill('PRESENT');
      if (overrides) {
        Object.entries(overrides).forEach(([idx, val]) => {
          const i = Number(idx);
          if (i < totalDays) dailyRecords[i] = val;
        });
      }
      return {
        id: crypto.randomUUID(),
        society,
        wing,
        flatNo,
        newspaper,
        dailyRecords,
        deliveryCharge: 25,
        customDailyRate: null
      };
    };

    return [
      // SAMARPAN - Wing C (26 Flats)
      make('SAMARPAN', 'C', '1405', 'T + AS'),
      make('SAMARPAN', 'C', '1404', 'T'),
      make('SAMARPAN', 'C', '1401', 'GR'),
      make('SAMARPAN', 'C', '1305', 'T', { 20: 'ABSENT' }),
      make('SAMARPAN', 'C', '1304', 'NB + Eco'),
      make('SAMARPAN', 'C', '1302', 'T'),
      make('SAMARPAN', 'C', '1202', 'Dainaik Bhaskar'),
      make('SAMARPAN', 'C', '1104', 'GR + Patrika'),
      make('SAMARPAN', 'C', '1103', 'GR + T'),
      make('SAMARPAN', 'C', '1101', 'T'),
      make('SAMARPAN', 'C', '1005', 'HT + Ratnagiri + Loksatta + Wealth'),
      make('SAMARPAN', 'C', '1004', 'Business STD'),
      make('SAMARPAN', 'C', '805', 'MT + GR (Sunday)'),
      make('SAMARPAN', 'C', '804', 'NBT + T (Sunday)'),
      make('SAMARPAN', 'C', '701', 'GR'),
      make('SAMARPAN', 'C', '605', 'GR + Mumbai Samachar (Wed and Sat)'),
      make('SAMARPAN', 'C', '604', 'GR'),
      make('SAMARPAN', 'C', '603', 'NBT'),
      make('SAMARPAN', 'C', '505', 'GR'),
      make('SAMARPAN', 'C', '502', 'T + AS + MT + Loksatta'),
      make('SAMARPAN', 'C', '403', 'T + AS'),
      make('SAMARPAN', 'C', '402', 'NBT'),
      make('SAMARPAN', 'C', '204', 'Eco + T (Sunday)'),
      make('SAMARPAN', 'C', '201', 'T + AS'),
      make('SAMARPAN', 'C', '104', 'MT + Samna + Sandhayanand (Sunday)'),
      make('SAMARPAN', 'C', '103', 'T'),

      // GAYATRI SATSANG - Wings D, C, A, BANK (28 Flats)
      make('GAYATRI SATSANG', 'D', '702', 'T'),
      make('GAYATRI SATSANG', 'D', '505', 'T + NBT'),
      make('GAYATRI SATSANG', 'D', '503', 'NBT'),
      make('GAYATRI SATSANG', 'D', '406', 'Loksatta'),
      make('GAYATRI SATSANG', 'D', '405', 'Indain + Dainaik bhaskar'),
      make('GAYATRI SATSANG', 'D', '403', 'NBT'),
      make('GAYATRI SATSANG', 'D', '303', 'MT'),
      make('GAYATRI SATSANG', 'D', '302', 'NBT'),
      make('GAYATRI SATSANG', 'D', '206', 'T'),
      make('GAYATRI SATSANG', 'D', '205', 'T'),
      make('GAYATRI SATSANG', 'D', '204', 'Loksatta'),
      make('GAYATRI SATSANG', 'D', '202', 'T + Eco (Sun) + Wealth'),
      make('GAYATRI SATSANG', 'D', '106', 'T'),
      make('GAYATRI SATSANG', 'D', '105', 'T'),
      make('GAYATRI SATSANG', 'C', '706', 'HT'),
      make('GAYATRI SATSANG', 'C', '505', 'T'),
      make('GAYATRI SATSANG', 'C', '502', 'HT'),
      make('GAYATRI SATSANG', 'C', '402', 'Loksatta'),
      make('GAYATRI SATSANG', 'C', '304', 'T + Mirror'),
      make('GAYATRI SATSANG', 'C', '302', 'T + NB'),
      make('GAYATRI SATSANG', 'C', '205', 'NBT + Eco'),
      make('GAYATRI SATSANG', 'C', '204', 'T'),
      make('GAYATRI SATSANG', 'C', '203', 'T + AS + NBT'),
      make('GAYATRI SATSANG', 'C', '106', 'Mint'),
      make('GAYATRI SATSANG', 'C', '103', 'Navakal'),
      make('GAYATRI SATSANG', 'A', '104', 'T'),
      make('GAYATRI SATSANG', 'A', '103', 'T'),
      make('GAYATRI SATSANG', 'BANK', 'Bank', 'Loksatta + Business Line'),

      // VASANT SAGAR - Wings F, E, D, C (35 Flats)
      make('VASANT SAGAR', 'F', '704', 'NBT'),
      make('VASANT SAGAR', 'F', '604', 'T + NBT'),
      make('VASANT SAGAR', 'F', '502', 'GR'),
      make('VASANT SAGAR', 'F', '504', 'GR'),
      make('VASANT SAGAR', 'F', '402', 'T'),
      make('VASANT SAGAR', 'F', '401', 'Dainaik Bhaskar'),
      make('VASANT SAGAR', 'F', '301', 'T (Sat and Sun)'),
      make('VASANT SAGAR', 'F', '303', 'HT'),
      make('VASANT SAGAR', 'F', '202', 'T'),
      make('VASANT SAGAR', 'F', '201', 'T'),
      make('VASANT SAGAR', 'F', '204', 'T'),
      make('VASANT SAGAR', 'F', '102', 'NBT + Business STD'),
      make('VASANT SAGAR', 'F', '103', 'MT'),
      make('VASANT SAGAR', 'E', '702', 'T + AS + MT'),
      make('VASANT SAGAR', 'E', '701', 'Loksatta'),
      make('VASANT SAGAR', 'E', '704', 'T + Vapyar'),
      make('VASANT SAGAR', 'E', '603', 'T + Indian'),
      make('VASANT SAGAR', 'E', '401', 'T'),
      make('VASANT SAGAR', 'E', '404', 'GR'),
      make('VASANT SAGAR', 'E', '403', 'MT + Prataksha'),
      make('VASANT SAGAR', 'E', '304', 'NBT'),
      make('VASANT SAGAR', 'E', '204', 'T'),
      make('VASANT SAGAR', 'D', '701', 'HT'),
      make('VASANT SAGAR', 'D', '703', 'Hindu'),
      make('VASANT SAGAR', 'D', '602', 'T'),
      make('VASANT SAGAR', 'D', '601', 'T'),
      make('VASANT SAGAR', 'D', '501', 'T + AS + MT'),
      make('VASANT SAGAR', 'D', '304', 'MT'),
      make('VASANT SAGAR', 'D', '204', 'T'),
      make('VASANT SAGAR', 'D', '201', 'HT + Mint + Wealth'),
      make('VASANT SAGAR', 'D', '202', 'Pravashi'),
      make('VASANT SAGAR', 'C', '701', 'GR'),
      make('VASANT SAGAR', 'C', '502', 'T'),
      make('VASANT SAGAR', 'C', '401', 'T + Samna'),
      make('VASANT SAGAR', 'C', '103', 'T + AS + Matrabhoomi'),

      // VICEROY COURT - Wings A, B, C, D, E, F (54 Flats)
      make('VICEROY COURT', 'A', '7A', 'T', { 0: 8, 1: 'ABSENT' }),
      make('VICEROY COURT', 'A', '7B', 'T', { 0: 8 }),
      make('VICEROY COURT', 'A', '7C', 'T'),
      make('VICEROY COURT', 'A', '7D', 'Divya Bhaskar / Chitralekha'),
      make('VICEROY COURT', 'A', '5B', 'NBT'),
      make('VICEROY COURT', 'A', '5C', 'Indian'),
      make('VICEROY COURT', 'A', '5D', 'T'),
      make('VICEROY COURT', 'A', '4A', 'T + AS'),
      make('VICEROY COURT', 'A', '4B', 'T + AS'),
      make('VICEROY COURT', 'A', '4C', 'T + MT'),
      make('VICEROY COURT', 'A', '4D', 'T + Wealth'),
make('VICEROY COURT', 'A', '2B', 'NBT + T'),
make('VICEROY COURT', 'A', '2C', 'ECO'),
make('VICEROY COURT', 'A', '1D', 'GR + T'),
make('VICEROY COURT', 'B', '8A', 'T + Wealth'),
make('VICEROY COURT', 'B', '8B', 'T + AS + MT'),
make('VICEROY COURT', 'B', '8D', 'NBT + T'),
make('VICEROY COURT', 'B', '7B', 'GR'),
make('VICEROY COURT', 'B', '6A', 'T'),
make('VICEROY COURT', 'B', '6D', 'T + Mirror'),
make('VICEROY COURT', 'B', '5C', 'T + AS + MT'),
make('VICEROY COURT', 'B', '4A', 'T'),
make('VICEROY COURT', 'B', '4C', 'MT + Chouffer'),
make('VICEROY COURT', 'B', '3A', 'T + AS'),
make('VICEROY COURT', 'B', '3C', 'NBT'),
make('VICEROY COURT', 'B', '2A', 'GR'),
make('VICEROY COURT', 'B', '2B', 'NBT'),
make('VICEROY COURT', 'B', '2C', 'T + AS'),
make('VICEROY COURT', 'B', '1A', 'Business STD + ECO + Hindu JR'),
make('VICEROY COURT', 'C', '11A', 'T'),
make('VICEROY COURT', 'C', '11B', 'Free press + Udayvani'),
make('VICEROY COURT', 'C', '10A', 'GR + T'),
make('VICEROY COURT', 'C', '10C', 'GR'),
make('VICEROY COURT', 'C', '10D', 'Prataylkal'),
make('VICEROY COURT', 'C', '9A', 'HT'),
make('VICEROY COURT', 'C', '8B', 'T + Mirror'),
make('VICEROY COURT', 'C', '8C', 'T + AS + MT'),
make('VICEROY COURT', 'C', '8D', 'Indian + NBT (Sunday)'),
make('VICEROY COURT', 'C', '7A', 'Indian + Mint'),
make('VICEROY COURT', 'C', '6D', 'T + AS + MT + Loksatta'),
make('VICEROY COURT', 'C', '5A', 'T + AS + MT'),
make('VICEROY COURT', 'C', '5C', 'T'),
make('VICEROY COURT', 'C', '4A', 'T + AS + MT'),
make('VICEROY COURT', 'C', '4C', 'Loksatta'),
make('VICEROY COURT', 'C', '4D', 'T + Loksatta (Sat and Sun)'),
make('VICEROY COURT', 'C', '3B', 'T + Lokmat'),
make('VICEROY COURT', 'C', '3C', 'NBT'),
make('VICEROY COURT', 'C', '2B', 'NBT + ECO + Wealth'),
make('VICEROY COURT', 'C', '2D', 'T'),
make('VICEROY COURT', 'C', '1B', 'HT'),
make('VICEROY COURT', 'C', '1C', 'T + MT (Sat and Sun)'),
make('VICEROY COURT', 'D', '11A', 'T'),
make('VICEROY COURT', 'D', '11D', 'Business STD + T (Sun)'),
make('VICEROY COURT', 'D', '10C', 'MT'),
make('VICEROY COURT', 'D', '10D', 'GR'),
make('VICEROY COURT', 'D', '9A', 'Indian'),
make('VICEROY COURT', 'D', '9B', 'GR'),
make('VICEROY COURT', 'D', '9C', 'T + AS + MT'),
make('VICEROY COURT', 'D', '7B', 'T + Dainaik Bhaskar'),
make('VICEROY COURT', 'D', '6B', 'T + AS'),
make('VICEROY COURT', 'D', '5A', 'T + AS + MT'),
make('VICEROY COURT', 'D', '4C', 'Indian'),
make('VICEROY COURT', 'D', '4D', 'Mid day + GR Mid day'),
make('VICEROY COURT', 'D', '2B', 'T + Loksatta'),
make('VICEROY COURT', 'D', '1A', 'T + AS'),
make('VICEROY COURT', 'D', '1B', 'GR Mid day'),
make('VICEROY COURT', 'D', '1C', 'MT'),
make('VICEROY COURT', 'E', '11B', 'T'),
make('VICEROY COURT', 'E', '10A', 'T + AS + MT (Fri to Sun)'),
make('VICEROY COURT', 'E', '5B', 'Hindu + RD (Maz)'),
make('VICEROY COURT', 'E', '2A', 'NBT'),
make('VICEROY COURT', 'E', '1B', 'Mid day'),
make('VICEROY COURT', 'F', '7C', 'T + MT + Loksatta'),
make('VICEROY COURT', 'F', '6A', 'T'),
make('VICEROY COURT', 'F', '6B', 'T'),
make('VICEROY COURT', 'F', '6D', 'GR'),
make('VICEROY COURT', 'F', '5A', 'NBT'),
make('VICEROY COURT', 'F', '4B', 'T + AS + NBT'),
make('VICEROY COURT', 'F', '3A', 'T (Sunday)'),
make('VICEROY COURT', 'F', '2B', 'T + AS'),
make('VICEROY COURT', 'F', '1D', 'T + HT + Loksatta (Sat and Sun)')
];
}
}