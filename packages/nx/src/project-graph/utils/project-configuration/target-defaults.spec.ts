import type { ProjectGraphProjectNode } from '../../../config/project-graph';
import type { TargetDefaultEntry } from '../../../config/nx-json';
import {
  findBestTargetDefault,
  normalizeTargetDefaults,
  readTargetDefaultsForTarget,
} from './target-defaults';

function node(
  name: string,
  opts: { root?: string; tags?: string[] } = {}
): ProjectGraphProjectNode {
  return {
    name,
    type: 'lib',
    data: { root: opts.root ?? name, tags: opts.tags ?? [] },
  } as ProjectGraphProjectNode;
}

describe('findBestTargetDefault', () => {
  it('returns null on empty entries', () => {
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        undefined,
        undefined,
        undefined,
        []
      )
    ).toBeNull();
  });

  it('matches exact target name', () => {
    const entries: TargetDefaultEntry[] = [{ target: 'test', cache: true }];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toEqual({ cache: true });
  });

  it('returns null when no target matches', () => {
    const entries: TargetDefaultEntry[] = [{ target: 'build', cache: true }];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toBeNull();
  });

  it('matches a target glob', () => {
    const entries: TargetDefaultEntry[] = [{ target: 'test:*', cache: true }];
    expect(
      findBestTargetDefault(
        'test:ci',
        undefined,
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toEqual({ cache: true });
  });

  it('matches executor when target equals executor string', () => {
    const entries: TargetDefaultEntry[] = [
      { target: '@nx/vite:test', inputs: ['x'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        '@nx/vite:test',
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toEqual({ inputs: ['x'] });
  });

  it('target+source beats target only', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', cache: true },
      { target: 'test', source: '@nx/vite', inputs: ['vite'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        'web',
        node('web'),
        '@nx/vite',
        entries
      )
    ).toEqual({ inputs: ['vite'] });
  });

  it('target+projects beats target+source', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', source: '@nx/vite', inputs: ['vite'] },
      { target: 'test', projects: 'web', inputs: ['byproject'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        'web',
        node('web'),
        '@nx/vite',
        entries
      )
    ).toEqual({ inputs: ['byproject'] });
  });

  it('target+projects+source beats all', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', cache: true },
      { target: 'test', source: '@nx/vite', inputs: ['vite'] },
      { target: 'test', projects: 'web', inputs: ['byproject'] },
      {
        target: 'test',
        projects: 'web',
        source: '@nx/vite',
        inputs: ['both'],
      },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        'web',
        node('web'),
        '@nx/vite',
        entries
      )
    ).toEqual({ inputs: ['both'] });
  });

  it('tie in same tier is broken by later array index', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', inputs: ['first'] },
      { target: 'test', inputs: ['second'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toEqual({ inputs: ['second'] });
  });

  it('exact target match beats glob match in same tier', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test:*', inputs: ['glob'] },
      { target: 'test', inputs: ['exact'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toEqual({ inputs: ['exact'] });
  });

  it('matches by project tag pattern', () => {
    const entries: TargetDefaultEntry[] = [
      {
        target: 'test',
        projects: 'tag:dotnet',
        options: { configuration: 'Release' },
      },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        'api',
        node('api', { tags: ['dotnet'] }),
        undefined,
        entries
      )
    ).toEqual({ options: { configuration: 'Release' } });
  });

  it('does not match when project tag is missing', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', projects: 'tag:dotnet', options: { a: 1 } },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        'web',
        node('web', { tags: ['node'] }),
        undefined,
        entries
      )
    ).toBeNull();
  });

  it('supports array projects with glob + negation', () => {
    const entries: TargetDefaultEntry[] = [
      {
        target: 'test',
        projects: ['apps/*', '!apps/legacy'],
        inputs: ['ok'],
      },
    ];
    const include = findBestTargetDefault(
      'test',
      undefined,
      'apps/web',
      node('apps/web', { root: 'apps/web' }),
      undefined,
      entries
    );
    const exclude = findBestTargetDefault(
      'test',
      undefined,
      'apps/legacy',
      node('apps/legacy', { root: 'apps/legacy' }),
      undefined,
      entries
    );
    expect(include).toEqual({ inputs: ['ok'] });
    expect(exclude).toBeNull();
  });

  it('skips entries requiring source when sourcePlugin is unknown', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', source: '@nx/vite', inputs: ['vite'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        'web',
        node('web'),
        undefined,
        entries
      )
    ).toBeNull();
  });

  it('skips entries requiring projects when no projectNode is provided', () => {
    const entries: TargetDefaultEntry[] = [
      { target: 'test', projects: 'web', inputs: ['x'] },
    ];
    expect(
      findBestTargetDefault(
        'test',
        undefined,
        undefined,
        undefined,
        undefined,
        entries
      )
    ).toBeNull();
  });
});

describe('normalizeTargetDefaults', () => {
  it('returns [] for undefined', () => {
    expect(normalizeTargetDefaults(undefined)).toEqual([]);
  });

  it('passes array through unchanged', () => {
    const input: TargetDefaultEntry[] = [{ target: 'test', cache: true }];
    expect(normalizeTargetDefaults(input)).toEqual(input);
  });

  it('converts record to array preserving insertion order', () => {
    const result = normalizeTargetDefaults({
      build: { cache: true },
      'e2e-ci--*': { cache: false },
      '@nx/vite:test': { inputs: ['x'] },
    });
    expect(result).toEqual([
      { target: 'build', cache: true },
      { target: 'e2e-ci--*', cache: false },
      { target: '@nx/vite:test', inputs: ['x'] },
    ]);
  });
});

describe('readTargetDefaultsForTarget (backwards-compat wrapper)', () => {
  it('still reads from the legacy record shape', () => {
    expect(
      readTargetDefaultsForTarget('build', {
        build: { inputs: ['a'] },
      })
    ).toEqual({ inputs: ['a'] });
  });

  it('reads from array shape', () => {
    expect(
      readTargetDefaultsForTarget('build', [{ target: 'build', inputs: ['a'] }])
    ).toEqual({ inputs: ['a'] });
  });

  it('returns null when no defaults apply', () => {
    expect(readTargetDefaultsForTarget('test', [])).toBeNull();
    expect(readTargetDefaultsForTarget('test', undefined)).toBeNull();
  });

  it('record: prefers executor key over target key', () => {
    expect(
      readTargetDefaultsForTarget(
        'build',
        {
          build: { inputs: ['by-target'] },
          '@nx/vite:build': { inputs: ['by-executor'] },
        },
        '@nx/vite:build'
      )
    ).toEqual({ inputs: ['by-executor'] });
  });

  it('record: later key wins for overlapping globs', () => {
    expect(
      readTargetDefaultsForTarget('e2e-ci--file-foo', {
        'e2e-ci--*': { options: { key: 'short' } },
        'e2e-ci--file-*': { options: { key: 'long' } },
      })
    ).toEqual({ options: { key: 'long' } });
  });
});
