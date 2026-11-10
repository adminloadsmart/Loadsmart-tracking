/**
 * Manual check of the ULIP FASTag API through our own client. Not run by CI or the app. Read-only.
 *
 *   npx tsx scripts/ulip-live-test.ts crossings <vehicle-number>   # raw count + parsed crossings
 *   npx tsx scripts/ulip-live-test.ts raw <vehicle-number>         # the transactions exactly as received
 *
 * Reads ULIP_API_URL, ULIP_USERNAME and ULIP_PASSWORD from .env (or the shell).
 */
import 'dotenv/config';
import { UlipClient } from '../src/modules/ingest-ulip/ulip.client';
import { toCrossing } from '../src/modules/ingest-ulip/ulip.contract';

const { ULIP_API_URL, ULIP_USERNAME, ULIP_PASSWORD } = process.env;
if (!ULIP_API_URL || !ULIP_USERNAME || !ULIP_PASSWORD) {
  console.error('Set ULIP_API_URL, ULIP_USERNAME and ULIP_PASSWORD (read from .env).');
  process.exit(1);
}
const client = new UlipClient({
  url: ULIP_API_URL,
  username: ULIP_USERNAME,
  password: ULIP_PASSWORD,
  timeoutMs: Number(process.env.ULIP_TIMEOUT_MS ?? 20_000),
  tokenTtlMs: Number(process.env.ULIP_TOKEN_TTL_MIN ?? 30) * 60_000,
});

const [command, vehicle] = process.argv.slice(2);

async function main() {
  if (!vehicle) throw new Error('Give a vehicle number, e.g. HR84A4138');
  const plate = vehicle.replace(/[\s-]/g, '').toUpperCase();
  const raw = await client.fetchCrossings(plate);
  if (command === 'raw') return raw;
  if (command !== 'crossings') throw new Error('Commands: crossings | raw');
  const crossings = raw.map((item) => toCrossing(item));
  return {
    received: raw.length,
    unreadable: crossings.filter((c) => !c).length,
    crossings: crossings
      .filter((c) => c !== null)
      .sort((a, b) => a.crossedAtMs - b.crossedAtMs)
      .map((c) => ({
        crossedAt: new Date(c.crossedAtMs).toISOString(),
        plaza: c.tollPlazaName,
        lat: c.lat,
        lng: c.lng,
        direction: c.laneDirection,
        seqNo: c.seqNo,
      })),
  };
}

main()
  .then((out) => console.log(JSON.stringify(out, null, 2)))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
