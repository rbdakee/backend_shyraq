import { ClockPort } from '../../application/ports/clock.port';

export class FixedClockAdapter extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }

  now(): Date {
    return new Date(this.fixed);
  }

  setNow(d: Date): void {
    this.fixed = new Date(d);
  }
}
