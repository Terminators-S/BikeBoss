import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const headerPath = resolve(process.argv[2] ?? 'include/device_signing_key.generated.h');
const header = readFileSync(headerPath, 'utf8');
const match = header.match(/#define\s+DEVICE_SIGNING_KEY_HEX\s+"([0-9a-fA-F]{64})"/u);

if (!match) {
  throw new Error(`No 32-byte DEVICE_SIGNING_KEY_HEX found in ${headerPath}`);
}

const password = createHmac('sha256', Buffer.from(match[1], 'hex'))
  .update('bikeboss-arduino-ota-v1')
  .digest('hex')
  .slice(0, 24);

process.stdout.write(password);
