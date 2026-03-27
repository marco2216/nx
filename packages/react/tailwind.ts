import { createGlobPatternsForDependencies as jsGenerateGlobs } from '@nx/js/src/utils/generate-globs';

let hasWarned = false;

/**
 * @deprecated `@nx/react/tailwind` will be removed in Nx 24. Migrate to Tailwind CSS v4 which no longer needs glob patterns.
 * See: https://nx.dev/docs/technologies/react/guides/using-tailwind-css-in-react
 */
export function createGlobPatternsForDependencies(
  dirPath: string,
  fileGlobPattern: string = '/**/*!(*.stories|*.spec).{tsx,ts,jsx,js,html}'
) {
  if (!hasWarned) {
    hasWarned = true;
    console.warn(
      `\nWARNING: "@nx/react/tailwind" is deprecated and will be removed in Nx 24.\n` +
        `Migrate to Tailwind CSS v4 which no longer needs glob patterns for content detection.\n` +
        `See: https://nx.dev/docs/technologies/react/guides/using-tailwind-css-in-react\n`
    );
  }
  try {
    return jsGenerateGlobs(dirPath, fileGlobPattern);
  } catch (e) {
    console.warn(
      '\nWARNING: There was an error creating glob patterns, returning an empty array\n' +
        `${e.message}\n`
    );
    return [];
  }
}
