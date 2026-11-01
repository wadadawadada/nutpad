import { Link } from 'react-router-dom';
import { Nut } from './Nut';

export default function Banner() {
  return (
    <Link to="/" className="banner" aria-label="NUTPAD — home">
      <div className="banner-sky" aria-hidden="true">
        <i className="cloud" style={{ animationDuration: '70s', animationDelay: '-10s' }} />
        <i className="cloud" style={{ animationDuration: '95s', animationDelay: '-55s', top: '50%', transform: 'scale(0.7)' }} />
      </div>
      <div className="banner-in">
        <div className="banner-nut"><Nut k="hazel" scale={2} /></div>
        <div className="banner-plaque">
          <div className="banner-title" aria-label="NUTPAD">
            {'NUTPAD'.split('').map((c, i) => <span key={i} style={{ animationDelay: `${i * 0.14}s` }}>{c}</span>)}
          </div>
          <div className="banner-tag">CASHU-NATIVE TOKEN LAUNCHPAD</div>
        </div>
        <div className="banner-nut"><Nut k="cashu" scale={2} /></div>
      </div>
    </Link>
  );
}
