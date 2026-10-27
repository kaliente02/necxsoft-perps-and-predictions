import { useEffect, useRef, useState } from 'react';
import { Side, formatUsd, priceDecimals, signedUsd } from '../lib/perps';
import { Modal } from './Modal';

export type PnlCardData = {
  symbol: string;
  side: Side;
  leverage: number;
  /** Net PnL in 6-decimal USD, after fees. */
  pnl: bigint;
  /** Return on collateral, in percent. */
  roi: number;
  entryPrice: bigint;
  /** Mark price for an open position, exit price for a closed one. */
  price: bigint;
  closed: boolean;
};

const W = 1200;
const H = 630;

function loadLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `${import.meta.env.BASE_URL}necxsoft-logo.png`;
  });
}

async function draw(canvas: HTMLCanvasElement, d: PnlCardData) {
  await document.fonts.ready;
  const logo = await loadLogo();
  const ctx = canvas.getContext('2d')!;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();
  const head = color('--font-head');
  const mono = color('--font-mono');
  const up = d.pnl >= 0n;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#07100d');
  bg.addColorStop(0.55, '#030504');
  bg.addColorStop(1, '#0b3f36');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, H * 0.2, 0, W * 0.85, H * 0.2, 520);
  glow.addColorStop(0, up ? 'rgba(42, 143, 123, 0.35)' : 'rgba(226, 106, 85, 0.28)');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(143, 169, 159, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  if (logo) ctx.drawImage(logo, 72, 64, 56, 56);
  const brandX = logo ? 144 : 72;
  ctx.fillStyle = color('--text');
  ctx.font = `700 30px ${head}`;
  ctx.fillText('NECXSOFT', brandX, 102);
  const perpsX = brandX + ctx.measureText('NECXSOFT').width + 12;
  ctx.fillStyle = color('--sage');
  ctx.font = `500 30px ${head}`;
  ctx.fillText('PERPS', perpsX, 102);

  // Market, side and leverage
  const isLong = d.side === Side.Long;
  ctx.font = `700 44px ${head}`;
  ctx.fillStyle = color('--text');
  ctx.fillText(d.symbol, 72, 220);
  const afterSymbol = 72 + ctx.measureText(d.symbol).width + 24;
  const badge = `${isLong ? 'LONG' : 'SHORT'} ${d.leverage.toFixed(1)}×`;
  ctx.font = `700 24px ${head}`;
  const badgeW = ctx.measureText(badge).width + 36;
  ctx.fillStyle = isLong ? 'rgba(21, 154, 156, 0.22)' : 'rgba(226, 106, 85, 0.22)';
  ctx.beginPath();
  ctx.roundRect(afterSymbol, 186, badgeW, 46, 23);
  ctx.fill();
  ctx.fillStyle = isLong ? color('--long-text') : color('--short-text');
  ctx.fillText(badge, afterSymbol + 18, 218);

  // ROI and PnL
  ctx.fillStyle = up ? color('--long-text') : color('--short-text');
  ctx.font = `700 132px ${head}`;
  ctx.fillText(`${up ? '+' : '−'}${Math.abs(d.roi).toFixed(2)}%`, 66, 380);
  ctx.font = `600 36px ${mono}`;
  ctx.fillText(signedUsd(d.pnl), 72, 440);

  // Prices
  const dp = priceDecimals(d.entryPrice);
  const stats: [string, string][] = [
    ['Entry price', `$${formatUsd(d.entryPrice, dp)}`],
    [d.closed ? 'Exit price' : 'Mark price', `$${formatUsd(d.price, dp)}`],
  ];
  stats.forEach(([label, value], i) => {
    const x = 72 + i * 300;
    ctx.fillStyle = color('--text-faint');
    ctx.font = `500 22px ${head}`;
    ctx.fillText(label, x, 520);
    ctx.fillStyle = color('--text');
    ctx.font = `600 30px ${mono}`;
    ctx.fillText(value, x, 560);
  });

  ctx.textAlign = 'right';
  ctx.fillStyle = color('--text-faintest');
  ctx.font = `500 20px ${head}`;
  ctx.fillText(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), W - 72, 560);
  ctx.textAlign = 'left';
}

export function PnlCardModal({ data, onClose }: { data: PnlCardData; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);

  useEffect(() => {
    if (!canvas.current) return;
    draw(canvas.current, data).then(() => setPreview(canvas.current!.toDataURL('image/png')));
  }, [data]);

  const filename = `necxsoft-${data.symbol.toLowerCase()}-${data.side === Side.Long ? 'long' : 'short'}.png`;

  async function copy() {
    try {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.current!.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'),
      );
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  const tweet = `${data.side === Side.Long ? 'Long' : 'Short'} ${data.symbol} ${data.leverage.toFixed(1)}× on Necxsoft Perps: ${data.roi >= 0 ? '+' : '−'}${Math.abs(data.roi).toFixed(2)}%`;

  return (
    <Modal title="Share PnL" onClose={onClose}>
      <canvas ref={canvas} width={W} height={H} hidden />
      <div className="pnl-preview">
        {preview ? <img src={preview} alt={`PnL card: ${tweet}`} /> : <span className="skeleton" />}
      </div>
      <div className="modal-actions triple">
        <button className="btn btn-secondary" onClick={copy} disabled={!preview}>
          {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy not supported' : 'Copy image'}
        </button>
        <a
          className="btn btn-secondary"
          href={`https://x.com/intent/post?text=${encodeURIComponent(tweet)}`}
          target="_blank"
          rel="noreferrer"
        >
          Post on X
        </a>
        <a className={`btn btn-primary ${preview ? '' : 'disabled'}`} href={preview ?? undefined} download={filename}>
          Download
        </a>
      </div>
    </Modal>
  );
}
