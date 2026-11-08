import { describe, expect, it } from 'vitest';
import { renderCheckOutput } from './github/checkRun.js';
import { githubText } from './github/markdown.js';
import type { ClassifiedFinding } from './product/scanner.js';

const ZWSP = '​';

const summary = { newCount: 1, existingCount: 0, waivedCount: 0, undecidedRuleKeys: [], perRule: [] } as unknown as Parameters<typeof renderCheckOutput>[0]['summary'];
const finding = (message: string): ClassifiedFinding =>
  ({ fingerprint: 'fp1', ruleKey: 'R-1', filePath: 'api/intake.py', startLine: 3, endLine: 3, state: 'new', message, exceptionId: null }) as ClassifiedFinding;

describe('githubText', () => {
  it('breaks @mentions so they render without pinging', () => {
    const out = githubText('contact @maintainer about this');
    expect(out).toContain(`@${ZWSP}maintainer`);
    expect(out).not.toContain('@maintainer');
  });

  it('breaks #issue references', () => {
    const out = githubText('duplicates #42 here');
    expect(out).toContain(`#${ZWSP}42`);
    expect(out).not.toContain('#42');
  });

  it('leaves # that cannot autolink, and is harmless on mid-word @', () => {
    expect(githubText('x@home')).toBe(`x@${ZWSP}home`); // not a mention on GitHub anyway
    expect(githubText('C# and ##')).toBe('C# and ##');
  });

  it('escapes link brackets and raw HTML', () => {
    const out = githubText('see [the docs](https://evil.example) <img src=x> A&B');
    expect(out).toContain('\\[the docs\\](https://evil.example)');
    expect(out).toContain('&lt;img src=x&gt;');
    expect(out).toContain('A&amp;B');
    expect(out).not.toContain('<');
  });
});

describe('renderCheckOutput sanitizes finding text', () => {
  const base = {
    kind: 'pull_request' as const,
    summary,
    rules: [{ ruleKey: 'R-1', title: 'Retention', version: 1 }],
    detailsUrl: 'https://lexcompiler.example/scan/1',
    defaultBranch: 'main',
    filesScanned: 5,
    truncated: false,
    lexcompilerVersion: 'test',
  };

  it('neutralizes a crafted finding message in the summary and annotations', () => {
    const hostile = 'leaks @victim, dup of #7, see [details](https://evil.example) <script>';
    const out = renderCheckOutput({ ...base, findings: [finding(hostile)] });
    expect(out.summary).not.toContain('@victim');
    expect(out.summary).not.toContain('#7');
    expect(out.summary).toContain('\\[details\\]');
    expect(out.summary).not.toContain('<script>');
    const ann = out.annotations.find((a) => a.path === 'api/intake.py')!;
    expect(ann.message).toContain(`@${ZWSP}victim`);
    expect(ann.message).toContain('\\[details\\]');
  });

  it('sanitizes rule titles and waiver text in tables and annotations', () => {
    const out = renderCheckOutput({
      ...base,
      rules: [{ ruleKey: 'R-1', title: 'Retention (ping @auditor)', version: 1 }],
      findings: [{ ...finding('x'), state: 'waived', exceptionId: 'e1' } as ClassifiedFinding],
      waivers: { e1: { expiresAt: null, reason: 'approved by @legal-lead, refs #9', decidedBy: 'legal@example.com' } },
    });
    expect(out.summary).not.toContain('@auditor');
    expect(out.summary).not.toContain('@legal-lead');
    expect(out.summary).toContain(`#${ZWSP}9`);
    expect(out.annotations[0].title).not.toContain('@auditor');
  });
});
