
import { mkdir, writeFile } from 'node:fs/promises';

const USERNAME = process.env.GITHUB_USERNAME || 'CamiloVenesia';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  throw new Error('Falta GITHUB_TOKEN para consultar GitHub.');
}

async function graphql(query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'camilo-profile-stats',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API devolvió HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(
      payload.errors.map((error) => error.message).join('; '),
    );
  }

  return payload.data;
}

const profileQuery = `
  query ($login: String!) {
    user(login: $login) {
      repositories(privacy: PUBLIC) {
        totalCount
      }
      contributionsCollection {
        contributionYears
      }
    }
  }
`;

const contributionsQuery = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-AR').format(value);
}

const now = new Date();
const today = isoDate(now);
const currentYear = now.getUTCFullYear();

const profile = await graphql(profileQuery, {
  login: USERNAME,
});

if (!profile?.user) {
  throw new Error(`No se encontró el usuario ${USERNAME}.`);
}

const publicRepos = profile.user.repositories.totalCount;

const years = [
  ...new Set([
    ...profile.user.contributionsCollection.contributionYears,
    currentYear,
  ]),
]
  .filter((year) => Number.isInteger(year) && year <= currentYear)
  .sort((a, b) => a - b);

const contributionDays = new Map();

let lifetimeCommits = 0;
let yearCommits = 0;
let yearContributions = 0;
let yearPullRequests = 0;

/**
 * GitHub permite consultar colecciones por períodos limitados.
 * Dividimos cada año en semestres para mantener las consultas
 * dentro de una duración inferior a un año, incluidos años bisiestos.
 */
for (const year of years) {
  const periods = [
    {
      start: new Date(Date.UTC(year, 0, 1)),
      end: new Date(Date.UTC(year, 6, 1) - 1000),
    },
    {
      start: new Date(Date.UTC(year, 6, 1)),
      end: new Date(Date.UTC(year + 1, 0, 1) - 1000),
    },
  ];

  for (const period of periods) {
    if (period.start > now) continue;

    const end = period.end > now ? now : period.end;

    const result = await graphql(contributionsQuery, {
      login: USERNAME,
      from: period.start.toISOString(),
      to: end.toISOString(),
    });

    const collection = result?.user?.contributionsCollection;

    if (!collection) {
      throw new Error(`No hay datos de contribuciones para ${year}.`);
    }

    lifetimeCommits += collection.totalCommitContributions;

    if (year === currentYear) {
      yearCommits += collection.totalCommitContributions;
      yearContributions +=
        collection.contributionCalendar.totalContributions;
      yearPullRequests += collection.totalPullRequestContributions;
    }

    const firstDay = isoDate(period.start);
    const lastDay = isoDate(end);

    for (const week of collection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        if (day.date < firstDay || day.date > lastDay) continue;

        contributionDays.set(
          day.date,
          day.contributionCount,
        );
      }
    }
  }
}

/**
 * Racha máxima histórica.
 * Los días sin contribuciones interrumpen la racha.
 */
let longestStreak = 0;
let runningStreak = 0;

const firstYear = years[0] ?? currentYear;
const cursor = new Date(Date.UTC(firstYear, 0, 1));

while (isoDate(cursor) <= today) {
  const count = contributionDays.get(isoDate(cursor)) ?? 0;

  if (count > 0) {
    runningStreak += 1;
    longestStreak = Math.max(longestStreak, runningStreak);
  } else {
    runningStreak = 0;
  }

  cursor.setUTCDate(cursor.getUTCDate() + 1);
}

/**
 * Racha actual: si hoy todavía no hubo actividad,
 * se permite contar la racha que terminó ayer.
 */
let currentStreak = 0;

let currentDay =
  (contributionDays.get(today) ?? 0) > 0
    ? today
    : shiftDate(today, -1);

const earliestDate = `${firstYear}-01-01`;

while (currentDay >= earliestDate) {
  if ((contributionDays.get(currentDay) ?? 0) === 0) break;

  currentStreak += 1;
  currentDay = shiftDate(currentDay, -1);
}

const statistics = {
  username: USERNAME,
  year: currentYear,
  today,
  publicRepos,
  yearCommits,
  yearContributions,
  yearPullRequests,
  lifetimeCommits,
  currentStreak,
  longestStreak,
};

/**
 * La tarjeta incluye los últimos 53 bloques semanales
 * del calendario de contribuciones.
 */
function createHeatmap(colors) {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end);

  start.setUTCDate(
    start.getUTCDate() - 52 * 7 - end.getUTCDay(),
  );

  const squares = [];

  for (let week = 0; week < 53; week++) {
    for (let day = 0; day < 7; day++) {
      const date = new Date(start);
      date.setUTCDate(start.getUTCDate() + week * 7 + day);

      if (date > end) continue;

      const count = contributionDays.get(isoDate(date)) ?? 0;

      const intensity =
        count === 0 ? 0 :
        count <= 2 ? 1 :
        count <= 5 ? 2 :
        count <= 9 ? 3 : 4;

      squares.push(`
        <rect
          x="${348 + week * 13}"
          y="${357 + day * 13}"
          width="10"
          height="10"
          rx="2"
          fill="${colors.heatmap[intensity]}"
        >
          <title>${escapeXml(isoDate(date))}: ${count} contribuciones</title>
        </rect>
      `);
    }
  }

  return squares.join('');
}

function createSvg(dark = true) {
  const colors = dark
    ? {
        background: '#15241B',
        border: '#375140',
        title: '#F3F5EE',
        text: '#D6E1D4',
        muted: '#A7BAA7',
        accent: '#B5D1A9',
        heatmap: [
          '#293B2F',
          '#496B50',
          '#658F69',
          '#83B78A',
          '#B5E1A8',
        ],
      }
    : {
        background: '#F5F4EE',
        border: '#CAD8C7',
        title: '#21382A',
        text: '#304B39',
        muted: '#617865',
        accent: '#466C4B',
        heatmap: [
          '#E0E7DC',
          '#B6D0B2',
          '#8DB48D',
          '#5F9168',
          '#326544',
        ],
      };

  const items = [
    {
      label: `COMMITS / ${currentYear}`,
      value: formatNumber(yearCommits),
    },
    {
      label: `CONTRIBUCIONES / ${currentYear}`,
      value: formatNumber(yearContributions),
    },
    {
      label: 'REPOSITORIOS PÚBLICOS',
      value: formatNumber(publicRepos),
    },
    {
      label: 'COMMITS HISTÓRICOS*',
      value: formatNumber(lifetimeCommits),
    },
    {
      label: 'RACHA ACTUAL',
      value: `${currentStreak} días`,
    },
    {
      label: 'RACHA MÁS LARGA',
      value: `${longestStreak} días`,
    },
  ];

  const metrics = items.map((item, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 50 + column * 350;
    const y = 171 + row * 108;

    return `
      <g>
        <text
          x="${x}" y="${y}"
          font-size="37" font-weight="700"
          fill="${colors.title}"
        >${escapeXml(item.value)}</text>
        <text
          x="${x}" y="${y + 27}"
          font-size="12" letter-spacing="1.35"
          font-weight="600" fill="${colors.muted}"
        >${escapeXml(item.label)}</text>
      </g>
    `;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1100"
  height="480"
  viewBox="0 0 1100 480"
  role="img"
  aria-labelledby="title description"
>
  <title id="title">Actividad de GitHub de ${escapeXml(USERNAME)}</title>
  <desc id="description">
    ${escapeXml(
      `${yearCommits} commits en ${currentYear}, ` +
      `${yearContributions} contribuciones, ` +
      `${currentStreak} días de racha actual y ` +
      `${longestStreak} días de racha máxima.`
    )}
  </desc>

  <rect
    x="1" y="1" width="1098" height="478" rx="23"
    fill="${colors.background}"
    stroke="${colors.border}" stroke-width="2"
  />

  <g font-family="Arial, Helvetica, sans-serif">
    <text
      x="50" y="48"
      fill="${colors.accent}"
      font-size="13"
      font-weight="700"
      letter-spacing="2"
    >GITHUB / CONTRIBUTION PULSE</text>

    <text
      x="50" y="101"
      fill="${colors.title}"
      font-family="Georgia, serif"
      font-size="36"
    >Código que se construye, día a día.</text>

    <text
      x="1050" y="48"
      text-anchor="end"
      fill="${colors.muted}"
      font-size="13"
    >${escapeXml(today)} · UTC</text>

    <line
      x1="50" y1="120" x2="1050" y2="120"
      stroke="${colors.border}"
    />

    <line
      x1="50" y1="227" x2="1050" y2="227"
      stroke="${colors.border}"
    />

    <line
      x1="50" y1="337" x2="1050" y2="337"
      stroke="${colors.border}"
    />

    <line
      x1="367" y1="137" x2="367" y2="323"
      stroke="${colors.border}"
    />

    <line
      x1="718" y1="137" x2="718" y2="323"
      stroke="${colors.border}"
    />

    ${metrics}

    <text
      x="50" y="371"
      fill="${colors.accent}"
      font-size="12"
      font-weight="700"
      letter-spacing="1.2"
    >ACTIVIDAD RECIENTE</text>

    <text
      x="50" y="395"
      fill="${colors.muted}"
      font-size="13"
    >Calendario de 53 semanas</text>

    ${createHeatmap(colors)}

    <text
      x="50" y="461"
      fill="${colors.muted}"
      font-size="11"
    >* Commits reconocidos como contribuciones por GitHub</text>

    <text
      x="1050" y="461"
      text-anchor="end"
      fill="${colors.muted}"
      font-size="11"
    >PRs ${currentYear}: ${yearPullRequests} · Actualización automática</text>
  </g>
</svg>`;
}

await mkdir('assets', { recursive: true });

await Promise.all([
  writeFile(
    'assets/stats-dark.svg',
    createSvg(true),
    'utf8',
  ),
  writeFile(
    'assets/stats-light.svg',
    createSvg(false),
    'utf8',
  ),
]);

console.log(
  `Estadísticas generadas para ${USERNAME} (${today}).`,
);
console.log(statistics);
