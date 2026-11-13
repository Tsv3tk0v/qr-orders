import { connect } from 'node:net';
import { formatPrice, pickText, type I18nText, type Locale } from '@qr/shared';

/**
 * Бележка 80 мм по ESC/POS (реш. 11, 17). Без фискални данни.
 * Кирилицата е в кодова таблица CP866; номерът на таблицата зависи от модела (ESC t n),
 * по подразбиране 17 (Epson и повечето съвместими).
 */
const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
const WIDTH = 48; // знака на ред при шрифт A, 80 мм

export function toCp866(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x43f) out.push(c - 0x410 + 0x80);
    else if (c >= 0x440 && c <= 0x44f) out.push(c - 0x440 + 0xe0);
    else if (c === 0x401) out.push(0xf0);
    else if (c === 0x451) out.push(0xf1);
    else if ('„“”«»'.includes(ch)) out.push(0x22);
    else if (ch === '–' || ch === '—') out.push(0x2d);
    else if (ch === '€') out.push(...[0x45, 0x55, 0x52]); // „EUR“ — CP866 няма знак за евро
    else out.push(0x3f);
  }
  return out;
}

export interface TicketData {
  businessName: string;
  locationName: string;
  number: number;
  createdAt: Date;
  locale: Locale;
  items: { qty: number; name: I18nText; lineCents: number; removed: { name: I18nText }[];
    addons: { name: I18nText; qty: number }[] }[];
  totalCents: number;
  statusUrl?: string;      // QR към страницата за следене
  footer: string;          // „Това не е фискален бон.“
  scanText?: string;
}

const pad = (left: string, right: string) => {
  const space = Math.max(1, WIDTH - left.length - right.length);
  return left.slice(0, WIDTH - right.length - 1) + ' '.repeat(space) + right;
};

export function buildTicket(t: TicketData, codepage = 17): Buffer {
  const b: number[] = [];
  const text = (s: string) => { b.push(...toCp866(s), LF); };
  const align = (n: 0 | 1 | 2) => b.push(ESC, 0x61, n);
  const size = (w: number, h: number) => b.push(GS, 0x21, ((w - 1) << 4) | (h - 1));
  const bold = (on: boolean) => b.push(ESC, 0x45, on ? 1 : 0);
  const rule = () => text('-'.repeat(WIDTH));
  const price = (c: number) => formatPrice(c, t.locale).replace(' €', '').replace('€', '');
  const time = t.createdAt.toLocaleString(t.locale === 'bg' ? 'bg-BG' : 'en-GB',
    { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  b.push(ESC, 0x40);            // нулиране
  b.push(ESC, 0x74, codepage);  // кодова таблица
  align(1);
  bold(true); size(2, 2); text(t.businessName); size(1, 1); bold(false);
  text(t.locationName);
  rule();
  text(t.locale === 'bg' ? 'ВАШИЯТ НОМЕР' : 'YOUR NUMBER');
  bold(true); size(8, 8); text(String(t.number)); size(1, 1); bold(false);
  text(time);
  rule();
  align(0);
  for (const it of t.items) {
    text(pad(`${it.qty}x ${pickText(it.name, t.locale).toUpperCase()}`, price(it.lineCents)));
    for (const a of it.addons) text(`   + ${a.qty > 1 ? `${a.qty}x ` : ''}${pickText(a.name, t.locale)}`);
    for (const r of it.removed) text(`   - ${t.locale === 'bg' ? 'без' : 'no'} ${pickText(r.name, t.locale)}`);
  }
  rule();
  bold(true); text(pad(t.locale === 'bg' ? 'СТОЙНОСТ' : 'TOTAL', `${price(t.totalCents)} EUR`)); bold(false);
  align(1);
  if (t.statusUrl) {
    const data = Buffer.from(t.statusUrl, 'utf8');
    const len = data.length + 3;
    b.push(LF);
    b.push(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00);            // модел 2
    b.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6);                     // размер на модула
    b.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);                  // корекция M
    b.push(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...data);
    b.push(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30);                  // печат
    if (t.scanText) text(t.scanText);
  }
  rule();
  text(t.footer);
  b.push(LF, LF, LF, LF);
  b.push(GS, 0x56, 0x42, 0);    // отрязване
  return Buffer.from(b);
}

/** Печат директно от сървъра (когато сървърът е в същата мрежа като принтера). */
export function sendToPrinter(host: string, port: number, data: Buffer, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('printer_timeout')); }, timeoutMs);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('connect', () => sock.end(data, () => { clearTimeout(timer); resolve(); }));
  });
}
