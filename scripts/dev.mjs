import concurrently from 'concurrently';

process.env.NODE_ENV = 'development';
const { result } = concurrently(
  [
    {
      name: 'server',
      command:
        'node scripts/varlock.mjs run -- node --import tsx --watch src/server/index.ts',
    },
    { name: 'client', command: 'vite' },
  ],
  { killOthers: ['failure', 'success'] },
);
try {
  await result;
} catch {
  process.exitCode = 1;
}
