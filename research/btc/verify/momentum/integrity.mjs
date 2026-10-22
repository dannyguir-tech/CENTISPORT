import { loadUpDown, WINDOW_SEC } from '../../lib/load.mjs';
for (const tf of ['5m','15m','1h','4h','1d']) {
  const R = loadUpDown(tf);
  let n=0, mism=0, eq=0, chain=0, chainBreak=0, srcs={}, closedLag=[];
  for (let i=0;i<R.length;i++) { const r=R[i];
    srcs[(r.resolutionSource||'').slice(0,60)+'|'+(r.cryptoMarketConfigId||'')] = (srcs[(r.resolutionSource||'').slice(0,60)+'|'+(r.cryptoMarketConfigId||'')]||0)+1;
    if (r.closedTs) closedLag.push(r.closedTs - r.windowEnd);
    if (r.priceToBeat!=null && r.finalPrice!=null) { n++; const up = r.finalPrice >= r.priceToBeat; if (up!==r.upWon) mism++; if (r.finalPrice===r.priceToBeat) eq++; }
    const p = R[i-1]; if (p && p.windowEnd===r.windowStart && p.finalPrice!=null && r.priceToBeat!=null) { chain++; if (Math.abs(p.finalPrice-r.priceToBeat)>1e-6) chainBreak++; }
  }
  closedLag.sort((a,b)=>a-b);
  console.log(tf, 'withBoth', n, 'winner!=sign(final-ptb)', mism, 'ties', eq, 'consecutive pairs', chain, 'ptb(b)!=final(a)', chainBreak, 'closedTs-windowEnd median', closedLag[closedLag.length>>1], 'p05', closedLag[Math.floor(closedLag.length*0.05)]);
  console.log('   sources', JSON.stringify(srcs));
}
