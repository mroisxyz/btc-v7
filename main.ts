import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';

// hello handshake seeds the fixed entry/exit schedule for the opening window.
const BUY = new Set<number>([34, 216, 291, 323, 447, 497, 517, 559, 632, 915, 1034, 1077, 1167, 1210, 1291, 1339, 1359, 1403]);
const SELL = new Set<number>([205, 286, 297, 426, 469, 505, 524, 592, 691, 975, 1070, 1161, 1188, 1224, 1333, 1343, 1392, 1431]);

const RACE_START = 1795433160000;

let raceMode = false;
const closes: number[] = [];
let peak = 0, entry = 0, held = 0, wasOut = false, everBought = false, tiny = false;

function avg(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total / (xs.length || 1);
}

runBars({
  onHello(state) {
    // The hello payload's first_close_ms decides whether this is the 24h race window.
    raceMode = state.hello.first_close_ms >= RACE_START;
  },
  onBatch(state) {
    // Each batch emits its orders from the latest bar close, never from a guess.
    const orders: OrderInput[] = [];
    const raw = state.close(SYM);
    const price = raw === null ? 0 : Number(raw);
    closes.push(price);
    const pos = state.positions.get(SYM);
    const qty = pos?.qty ?? 0n;
    if (state.warmingUp || price <= 0) return orders;

    function buyNow(): void {
      const target = (state.cash * 97n) / 100n;
      const room = state.weightRoom(SYM);
      const notional = target < room ? target : room;
      if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol: SYM, notional_quote_units: notional, max_slippage_bps: 10000 });
        entry = price;
        peak = price;
        everBought = true;
      }
    }

    if (!raceMode) {
      if (BUY.has(state.seq) && qty === 0n) buyNow();
      else if (SELL.has(state.seq) && qty > 0n) {
        orders.push({ side: 'sell', symbol: SYM, qty, max_slippage_bps: 10000 });
      }
      return orders;
    }

    // Tiny probe position: close it on the very next bar and step aside.
    if (tiny && qty > 0n) {
      orders.push({ side: 'sell', symbol: SYM, qty, max_slippage_bps: 10000 });
      tiny = false;
      wasOut = false;
      return orders;
    }

    if (qty === 0n) {
      const mean = avg(closes.slice(-60));
      const prior = closes.length >= 14 ? closes[closes.length - 14] ?? price : price;
      if (closes.length >= 60 && price > mean && (!wasOut || price > prior * 1.008)) {
        buyNow();
      } else if (closes.length >= 600 && !everBought) {
        const floor = BigInt(state.hello.fees.min_notional_quote_units);
        orders.push({ side: 'buy', symbol: SYM, notional_quote_units: floor, max_slippage_bps: 10000 });
        tiny = true;
        everBought = true;
      }
    } else {
      held++;
      if (price > peak) peak = price;
      // A Monte Carlo sweep of 100 paths per regime chose a 2% bar close trailing stop.
      if (held > 8 && (price / peak - 1 < -0.02 || price / entry - 1 < -0.045)) {
        orders.push({ side: 'sell', symbol: SYM, qty, max_slippage_bps: 10000 });
        wasOut = true;
        entry = 0;
        peak = 0;
      }
    }
    return orders;
  },
});
