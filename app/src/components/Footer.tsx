import { NETWORK_LABEL } from '../client';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <img src={`${import.meta.env.BASE_URL}necxsoft-logo.png`} alt="" width={24} height={24} />
          <span>
            Necxsoft<span className="brand-product">Perps</span>
          </span>
        </div>
        <p className="footer-risk">
          Perpetual futures are leveraged products and can result in the loss of your entire collateral. Prices are provided
          by an oracle and may differ from other venues. Trade only with funds you can afford to lose.
        </p>
        <div className="footer-meta">
          <span>© {new Date().getFullYear()} Necxsoft. All rights reserved.</span>
          <span className="faint">Built on Solana · {NETWORK_LABEL}</span>
          <a href="https://necxsoft.com" target="_blank" rel="noreferrer">necxsoft.com</a>
        </div>
      </div>
    </footer>
  );
}
