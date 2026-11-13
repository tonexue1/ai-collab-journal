import manifest from '../package.json' with {type:'json'};
// Bundles carry a content hash; source-only tests deliberately identify as source.
export const pluginBuild=typeof __JOURNAL_BUILD__==='undefined'?{version:manifest.version,id:'source'}:__JOURNAL_BUILD__;
