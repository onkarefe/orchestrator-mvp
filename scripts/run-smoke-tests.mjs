import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const scripts = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('-smoke-test.mjs')).sort();
let failed = 0;
for (const script of scripts) {
  console.log('Running ' + script);
  const result = spawnSync(process.execPath, ['scripts/' + script], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, WALLPAPER_SKUS: '20-140.1-3,20-140.1-4,20-331.1-3', CHECKOUT_SECURITY_GATE_MODE: 'off', WANDINI_CHECKOUT_HMAC_SECRET: '',
      SHOPIFY_WRITE_ENABLED: 'false', SHOPIFY_UPDATE_EXECUTOR_ENABLED: 'false', FTP_UPLOAD_ENABLED: 'false' },
  });
  if (result.status !== 0) failed++;
}
console.log(scripts.length + ' smoke suites; ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
