// The builder service's entry point (builder-service.ts): `node src/builder-main.ts`. It reads only the Filebase
// settings and its port; it opens no kernel, no store and no Discord connection.
import { serve } from './builder-service.ts';

const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`builder: ${name} is not set`);
  return value;
};
const port = Number(process.env.BUILDER_PORT ?? 8099);
serve(port, {
  accessKey: need('FILEBASE_ACCESS_KEY'),
  secret: need('FILEBASE_SECRET'),
  bucket: need('FILEBASE_BUCKET'),
  gateway: process.env.FILEBASE_GATEWAY ?? 'https://ipfs.filebase.io/ipfs/',
});
console.log(JSON.stringify({ event: 'builder-ready', port }));
