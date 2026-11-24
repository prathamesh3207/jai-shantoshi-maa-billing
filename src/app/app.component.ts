import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BillingService } from './services/billing.service';
import { CalculatedFlat } from './models/delivery.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  billing = inject(BillingService);

  showRateModal = signal(false);
  showAddModal = signal(false);
  selectedInvoice = signal<CalculatedFlat | null>(null);

  newPaperName = '';
  newPaperRate = 6;
  showReplaceModal = signal(false);
  findNewspaperText = '';
  replaceNewspaperText = '';
  replaceScopeSociety = 'ALL';
  replaceExactOnly = false;
  replaceStatusMsg = signal<string>('');

  openReplaceModal() {
    this.replaceScopeSociety = this.billing.selectedSociety();
    this.replaceStatusMsg.set('');
    this.showReplaceModal.set(true);
  }

  executeBulkReplace() {
    if (!this.findNewspaperText.trim()) return;
    const count = this.billing.bulkReplaceNewspaper(
      this.findNewspaperText,
      this.replaceNewspaperText,
      this.replaceScopeSociety,
      this.replaceExactOnly
    );
    this.replaceStatusMsg.set(
      count > 0
        ? `✅ Updated ${count} flat(s) successfully!`
        : `⚠️ No flats matched "${this.findNewspaperText}".`
    );
  }

  newFlat = {
    society: 'SAMARPAN',
    wing: 'C',
    flatNo: '',
    newspaper: 'T',
    deliveryCharge: 25
  };

  getRateEntries(): Array<{ name: string; rate: number }> {
    return Object.entries(this.billing.rates()).map(([name, rate]) => ({ name, rate }));
  }

  addRateEntry() {
    if (!this.newPaperName.trim()) return;
    this.billing.addNewRate(this.newPaperName, this.newPaperRate);
    this.newPaperName = '';
    this.newPaperRate = 6;
  }

  submitNewFlat() {
    if (!this.newFlat.flatNo.trim()) return;
    this.billing.addSubscription({
      society: this.newFlat.society.trim().toUpperCase() || 'GENERAL',
      wing: this.newFlat.wing.trim().toUpperCase() || '-',
      flatNo: this.newFlat.flatNo.trim(),
      newspaper: this.newFlat.newspaper.trim() || 'T',
      deliveryCharge: Number(this.newFlat.deliveryCharge) || 25,
      customDailyRate: null
    });
    this.newFlat.flatNo = '';
    this.showAddModal.set(false);
  }

  openInvoice(flat: CalculatedFlat) {
    this.selectedInvoice.set(flat);
  }

  printInvoice() {
    window.print();
  }

    shareWhatsApp(inv: CalculatedFlat) {
    const text =
      `*JAI SHANTOSHI MAA - NEWSPAPER BILL*\n` +
      `Month: ${this.billing.formattedMonthLabel()}\n` +
      `Society: ${inv.society} | Wing: ${inv.wing} | Flat: ${inv.flatNo}\n` +
      `Paper: ${inv.newspaper}\n` +
      `Delivered Days: ${inv.daysPresent} | Absent: ${inv.daysAbsent}\n` +
      `Paper Amount: Rs. ${inv.paperAmount}\n` +
      `Delivery Charge: Rs. ${inv.deliveryCharge}\n` +
      `*Grand Total Due: Rs. ${inv.grandTotal}*`;
    window.open(`https://whatsapp.com{encodeURIComponent(text)}`, '_blank');
  }


  confirmReset() {
    if (confirm('Reset all flats, rates, and attendance back to default Excel data?')) {
      this.billing.resetDemoData();
    }
  }

  onFileUpload(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const lines = reader.result.split(/\r?\n/);
        let currentSoc = 'IMPORTED';
        let currentWing = '-';
        for (const line of lines) {
          const cols = line.split(',');
          const c0 = cols[0]?.trim() || '';
          const c1 = cols[1]?.trim() || '';
          const c2 = cols[2]?.trim() || '';
          if (c0 && !c1 && !c2 && !c0.includes('JAI SHANTOSHI') && !c0.includes('GRAND TOTAL')) {
            currentSoc = c0;
            continue;
          }
          if (!c1 || c1 === 'Flat No' || c0 === 'GRAND TOTAL') continue;
          if (c0) currentWing = c0;
          this.billing.addSubscription({
            society: currentSoc,
            wing: currentWing,
            flatNo: c1,
            newspaper: c2 || 'T',
            deliveryCharge: Number(cols[37]) || 25,
            customDailyRate: null
          });
        }
      }
    };
    reader.readAsText(input.files[0]);
  }

  downloadCsv() {
    const headers = this.billing.daysHeader();
    const rows = this.billing.calculatedSubscriptions();
    const headerRow = [
      'Society', 'Wing', 'Flat No', 'Newspaper', 'Daily Rate',
      ...headers.map(h => h.dateStr),
      'Days Present', 'Days Absent', 'Paper Amount', 'Delivery Charge', 'Grand Total'
    ];
    const csvLines = [headerRow.join(',')];

    for (const r of rows) {
      const dayCols = r.breakdown.map(b => (b.status === 'ABSENT' || b.status === 0 ? '0' : b.charge));
      csvLines.push([
        `"${r.society}"`,
        `"${r.wing}"`,
        `"${r.flatNo}"`,
        `"${r.newspaper}"`,
        r.effectiveDailyRate,
        ...dayCols,
        r.daysPresent,
        r.daysAbsent,
        r.paperAmount,
        r.deliveryCharge,
        r.grandTotal
      ].join(','));
    }

    const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Jai_Shantoshi_Maa_Billing_${this.billing.billingMonth()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
    editSingleDayRate(event: Event, flatId: string, dayIndex: number, dateStr: string, currentCharge: number) {
    event.preventDefault();
    const input = prompt(
      `Set custom rate (₹) for ${dateStr}:\n• Enter a number (e.g. 8 or 12)\n• Enter 0 for Absent\n• Leave blank to use default daily rate`,
      String(currentCharge)
    );
    if (input === null) return; // Cancelled
    this.billing.setDayCustomRate(flatId, dayIndex, input);
  }
  dayEditMode = signal(false);
  editingDayCell = signal<{
    flatId: string;
    flatLabel: string;
    dayIndex: number;
    dateStr: string;
    weekday: string;
    amount: number | '';
  } | null>(null);

  onDayCellClick(row: CalculatedFlat, dayIndex: number, day: { dateStr: string; weekday: string; charge: number }) {
    if (this.dayEditMode()) {
      this.openDayEditor(row, dayIndex, day);
    } else {
      this.billing.toggleDay(row.id, dayIndex);
    }
  }

  openDayEditor(row: CalculatedFlat, dayIndex: number, day: { dateStr: string; weekday: string; charge: number }, event?: Event) {
    if (event) event.preventDefault();
    this.editingDayCell.set({
      flatId: row.id,
      flatLabel: `${row.society} • Wing ${row.wing} • Flat ${row.flatNo}`,
      dayIndex,
      dateStr: day.dateStr,
      weekday: day.weekday,
      amount: day.charge
    });
  }

  saveSingleDayRate() {
    const cell = this.editingDayCell();
    if (!cell) return;
    this.billing.setDayCustomRate(cell.flatId, cell.dayIndex, cell.amount);
    this.editingDayCell.set(null);
  }

  resetSingleDayRate() {
    const cell = this.editingDayCell();
    if (!cell) return;
    this.billing.setDayCustomRate(cell.flatId, cell.dayIndex, null);
    this.editingDayCell.set(null);
  }

}
