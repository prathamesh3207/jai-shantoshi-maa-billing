export type DayStatus = 'PRESENT' | 'ABSENT' | number;

export interface DayHeader {
  dayNum: number;
  dateStr: string;
  weekday: string;
  dayOfWeek: number;
  isWeekend: boolean;
}

export interface DayBreakdown {
  dayNum: number;
  dateStr: string;
  weekday: string;
  status: DayStatus;
  charge: number;
  isScheduledDay: boolean;
}

export interface FlatSubscription {
  id: string;
  society: string;
  wing: string;
  flatNo: string;
  newspaper: string;
  dailyRecords: DayStatus[];
  deliveryCharge: number;
  customDailyRate?: number | null;
}

export interface CalculatedFlat extends FlatSubscription {
  daysPresent: number;
  daysAbsent: number;
  totalDays: number;
  effectiveDailyRate: number;
  paperAmount: number;
  grandTotal: number;
  breakdown: DayBreakdown[];
}
