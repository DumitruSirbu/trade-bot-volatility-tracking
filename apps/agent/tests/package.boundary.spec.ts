import * as fs from 'fs';
import * as path from 'path';

describe('package.boundary', () => {
  it('should not depend on @bot/engine, @bot/analysis, or @bot/mcp', () => {
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

    const bannedDependencies = ['@bot/engine', '@bot/analysis', '@bot/mcp'];
    const depSections = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ];

    for (const section of depSections) {
      const deps = packageJson[section] || {};
      for (const banned of bannedDependencies) {
        expect(deps).not.toHaveProperty(banned, `${banned} found in ${section}`);
      }
    }
  });
});
