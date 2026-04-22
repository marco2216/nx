const lessLoader = require('less-loader');

let hasWarned = false;

module.exports = function (...args) {
  if (!hasWarned) {
    hasWarned = true;
    console.warn(
      '\n⚠️  Less support in Nx is deprecated and will be removed in a future version.\n' +
        '   Please migrate to CSS, SCSS, or Tailwind CSS.\n' +
        '   See: https://nx.dev/recipes/tips-n-tricks/migrate-from-unsupported-stylesheets\n'
    );
  }
  return lessLoader.apply(this, args);
};

if (lessLoader.raw) {
  module.exports.raw = lessLoader.raw;
}
