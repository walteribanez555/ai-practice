const esbuild = require('esbuild');

const isProduction = process.argv.includes('--prod');
const target = process.argv.find(a => a.startsWith('--target='))?.split('=')[1];

const baseConfig = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  target: 'node24',
  platform: 'node',
  external: ['aws-sdk', '@aws-sdk'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
  },
  logLevel: 'info',
};

const builds = {
  lambda: {
    ...baseConfig,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
  },
  ecs: {
    ...baseConfig,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.js',
  },
};

const build = async () => {
  const targets = target ? [target] : Object.keys(builds);

  for (const t of targets) {
    if (!builds[t]) {
      console.error(`✗ Unknown target: ${t}. Available: ${Object.keys(builds).join(', ')}`);
      process.exit(1);
    }
    await esbuild.build(builds[t]);
    console.log(`✓ Built ${t}: dist/${builds[t].outfile.split('/').pop()}`);
  }

  console.log(`  Environment: ${isProduction ? 'production (minified)' : 'development (sourcemap)'}`);
};

build().catch((error) => {
  console.error('✗ Build failed:', error);
  process.exit(1);
});

module.exports = { builds, build };
