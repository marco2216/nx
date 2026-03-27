import { createGlobPatternsForDependencies as jsGenerateGlobs } from '@nx/js/src/utils/generate-globs';

let hasWarned = false;

/**
 * @deprecated `@nx/angular/tailwind` will be removed in Nx 24. Migrate to Tailwind CSS v4 which no longer needs glob patterns.
 * See: https://nx.dev/docs/technologies/angular/guides/using-tailwind-css-with-angular
 */
export function createGlobPatternsForDependencies(
  dirPath: string,
  fileGlobPattern: string = '/**/!(*.stories|*.spec).{ts,html}'
) {
  if (!hasWarned) {
    hasWarned = true;
    console.warn(
      `\nWARNING: "@nx/angular/tailwind" is deprecated and will be removed in Nx 24.\n` +
        `Migrate to Tailwind CSS v4 which no longer needs glob patterns for content detection.\n` +
        `See: https://nx.dev/docs/technologies/angular/guides/using-tailwind-css-with-angular\n`
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
