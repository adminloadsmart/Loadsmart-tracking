/**
 * Manual check of the Intugine API through our own client. Not run by CI or the app.
 *
 *   npx tsx scripts/sim-live-test.ts consent <10-digit-number>
 *   npx tsx scripts/sim-live-test.ts find <invoice>
 *   npx tsx scripts/sim-live-test.ts status <intugineTripId> [limit]
 *   npx tsx scripts/sim-live-test.ts end <intugineTripId>
 *   npx tsx scripts/sim-live-test.ts start <number> <srcLat,srcLng> <destLat,destLng> <truckNumber> <invoice> --yes
 *
 * `consent` re-sends the driver's SMS while the number is pending. `start` creates a BILLED trip:
 * it needs --yes, and you should `end` the trip straight afterwards.
 */
import 'dotenv/config';
import { IntugineClient } from '../src/modules/ingest-sim/intugine.client';
import { normalizePhone } from '../src/modules/ingest-sim/intugine.contract';

const { INTUGINE_API_URL, INTUGINE_USERNAME, INTUGINE_PASSWORD } = process.env;
if (!INTUGINE_API_URL || !INTUGINE_USERNAME || !INTUGINE_PASSWORD) {
  console.error('Set INTUGINE_API_URL, INTUGINE_USERNAME and INTUGINE_PASSWORD (read from .env).');
  process.exit(1);
}
const client = new IntugineClient({
  url: INTUGINE_API_URL,
  username: INTUGINE_USERNAME,
  password: INTUGINE_PASSWORD,
  timeoutMs: Number(process.env.INTUGINE_TIMEOUT_MS ?? 15_000),
  slowTimeoutMs: Number(process.env.INTUGINE_SLOW_TIMEOUT_MS ?? 120_000),
});

const [command, ...args] = process.argv.slice(2);
const coords = (text: string | undefined): [number, number] => {
  const [lat, lng] = (text ?? '').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`Bad coordinates: ${text}`);
  return [lat, lng];
};
const phone = (text: string | undefined) => {
  const tel = normalizePhone(text);
  if (!tel) throw new Error('Not a 10-digit Indian mobile number');
  return tel;
};

async function main() {
  switch (command) {
    case 'consent':
      return client.checkConsent(phone(args[0]));
    case 'find':
      return { intugineTripId: await client.findTripByInvoice(args[0]) };
    case 'status':
      return client.fetchLocations(args[0], Number(args[1] ?? 5));
    case 'end':
      return { ended: await client.endTrip(args[0]) };
    case 'start': {
      if (!args.includes('--yes')) throw new Error('start creates a billed trip: add --yes');
      return client.startTrip({
        tel: phone(args[0]),
        src: coords(args[1]),
        srcName: 'Test source',
        dest: coords(args[2]),
        destName: 'Test destination',
        truckNumber: args[3],
        invoice: args[4],
        loadId: `manual-${Date.now()}`,
      });
    }
    default:
      throw new Error(
        'Commands: consent | find | status | end | start (see the header of this file)',
      );
  }
}

main()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
