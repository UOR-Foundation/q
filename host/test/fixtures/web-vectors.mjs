// Writes web-vectors.json: fixed inputs and the labels the host computes for them. The website holds a
// copy and must compute the same labels in a browser. Written as ASCII, so no tool can renormalize a
// character. Run from host/: node test/fixtures/web-vectors.mjs
import { writeFile } from 'node:fs/promises';
import { labelOf } from '../../src/address.ts';
import { manifest, normalize, questionKey, webAnswer } from '../../src/records.ts';

const label = (name) => labelOf({ type: 'fixture', name });
const record = manifest({
  kernel: { holo: label('kernel'), commit: 'c'.repeat(40) },
  community: { holo: label('community'), commit: 'a'.repeat(40) },
  corpus: labelOf({ type: 'corpus', items: [label('one'), label('two')].sort() }),
  prompt: label('prompt'),
  model: 'test-model',
  retrieval: { embedder: 'test-words', retrieve: 6, medium: '0.6', high: '0.7' },
});
const manifestLabel = labelOf(record);
// Case, spacing, a tab and a line break, and an e with a combining accent that NFC composes.
const questions = ['What is a holo?', '  WHAT   is a\tHolo?\n', `Que${String.fromCharCode(0x301)} es UOR?`, `Qu${String.fromCharCode(0xe9)} es UOR?`, ''];
const answer = webAnswer({
  key: questionKey(questions[0], manifestLabel), manifest: manifestLabel, outcome: 'answer', band: 'high', level: 'open',
  text: 'A **holo** is a packaged app that checks itself [1].\n\n- Built by `prism-code`\n- Named by its label',
  decision: null,
  sources: [
    { n: 1, label: label('one'), url: 'https://uor.foundation/docs/holo.md', source: 'website', level: 'some-true', cited: true },
    { n: 2, label: label('two'), url: 'https://github.com/UOR-Foundation/prism', source: 'github', level: 'open', cited: false },
  ],
  tools: 0, kernel: record.kernel.holo, community: record.community.holo,
});

await writeFile(new URL('./web-vectors.json', import.meta.url), `${JSON.stringify({
  manifest: { record, label: manifestLabel },
  questions: questions.map((question) => ({ question, normalized: normalize(question), key: questionKey(question, manifestLabel) })),
  answer: { record: answer, label: labelOf(answer) },
}, null, 2).replace(/[^ -~\s]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`);
