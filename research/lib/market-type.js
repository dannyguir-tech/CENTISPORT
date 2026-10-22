// Market/side classification ported from vendor/pm-sports-dashboard.user.js
// (classifyMarketType, normalizeDisplaySide). Regexes are copied verbatim so research
// buckets line up with the dashboard's; only the return values are mapped to the
// dataset enums. Unlike the userscript, a missing sport does not short-circuit to
// 'unknown' — the question text alone is still classified.

export const ESPORTS = new Set(['esports', 'lol', 'leagueoflegends', 'league-of-legends',
  'csgo', 'cs2', 'counterstrike', 'dota', 'dota2', 'dota-2', 'valorant', 'val',
  'rocketleague', 'r6', 'siege', 'overwatch', 'apex']);

export function isEsports(sport) {
  return !!sport && ESPORTS.has(String(sport).toLowerCase());
}

// -> 'moneyline' | 'spread' | 'total' | 'prop' | 'map' | 'other'
export function classifyMarketType(question, sport) {
  const q = String(question == null ? '' : question).toLowerCase();
  if (!q.trim()) return 'other';
  if (isEsports(sport)) {
    if (/\b(total|over|under|maps?\s+(played|won)|map\s*count)\b/.test(q)) return 'total';
    if (/\bmap\s*\d|\b(first|second|third)\s+map\b|map\s+\d\s+winner|\bgame\s*[1-5]\b|\bgame\s*(one|two|three|four|five)\b|game\s*\d\s+winner/.test(q)) return 'map';
    return 'moneyline';
  }
  // Order prop > total > spread > moneyline: player-stat questions also contain "over X.X".
  const isProp = /\b(points|rebounds|assists|threes?|made\s*3|steals|blocks|turnovers|double[\s-]?double|triple[\s-]?double|first\s+basket|to\s+score|will\s+score|home\s+runs?|strikeouts?|hits|rbis?|passing|rushing|receiving|completions|touchdowns?|yards|sacks|receptions|tackles|interceptions)\b/.test(q);
  const isTotal = /\b(over|under|total)\s+(points|runs|goals|maps|games|kills|rounds|\d)/.test(q)
               || /\b(o\/u|over\/under)\b/.test(q);
  const isSpread = /\b(spread|cover|handicap|favored)\b/.test(q)
                || /\(\s*[+\-]\d+(\.\d+)?\s*\)/.test(q)
                || /[+\-]\d+(\.\d+)?\s*(point|run|goal)/.test(q);
  return isProp ? 'prop' : isTotal ? 'total' : isSpread ? 'spread' : 'moneyline';
}

export function normalizeName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// -> { sideType: 'over'|'under'|'yes'|'no'|'team'|'other', line: number|null }
// For spreads, line is this outcome's signed handicap (favorite negative).
export function classifySide(question, outcome) {
  const raw = String(outcome == null ? '' : outcome).trim();
  const q = String(question == null ? '' : question);
  const ql = q.toLowerCase();
  const rl = raw.toLowerCase();

  // Spread first so a team name containing "over"/"under" can't fall into the O/U branch.
  const spreadMatch = q.match(/spread:\s*(.+?)\s*\(([+\-]?\d+(?:\.\d+)?)\)/i);
  if (spreadMatch && raw) {
    const favoriteLine = parseFloat(spreadMatch[2]);
    if (!isNaN(favoriteLine)) {
      // Yes/No spread markets: "Yes" backs the named team at the quoted line.
      if (rl === 'yes') return { sideType: 'yes', line: favoriteLine };
      if (rl === 'no') return { sideType: 'no', line: -favoriteLine || 0 };
      const same = normalizeName(raw) === normalizeName(spreadMatch[1].trim());
      const line = same ? favoriteLine : -favoriteLine;
      return { sideType: 'team', line: line === 0 ? 0 : line };
    }
  }

  const isOU = /\b(o\/u|over\/under)\b/.test(ql)
            || /\bover\s+[+\-]?\d/.test(ql)
            || /\bunder\s+[+\-]?\d/.test(ql);
  if (isOU) {
    let line = null;
    let m = ql.match(/(?:o\/u|over\/under)\s*([+\-]?\d+(?:\.\d+)?)/);
    if (!m) m = ql.match(/(?:over|under)\s*([+\-]?\d+(?:\.\d+)?)/);
    if (m) line = parseFloat(m[1]);
    const lm = raw.match(/^(over|under)\s*([+\-]?\d+(?:\.\d+)?)/i);
    if (lm) line = parseFloat(lm[2]);
    if (rl === 'yes' || rl === 'over' || /^over\b/.test(rl)) return { sideType: 'over', line };
    if (rl === 'no' || rl === 'under' || /^under\b/.test(rl)) return { sideType: 'under', line };
    return { sideType: 'other', line };
  }
  if (rl === 'yes') return { sideType: 'yes', line: null };
  if (rl === 'no') return { sideType: 'no', line: null };
  if (!raw) return { sideType: 'other', line: null };
  return { sideType: 'team', line: null };
}
