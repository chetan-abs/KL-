const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Keep Metro's watcher off generated and server-side files. Without this it
// watches the web bundle output and backend/, and any write there triggers a
// hot-reload loop during development.
//
// Two things make these patterns fiddly, and getting either wrong fails in a
// way that does not look like a blockList problem:
//
// 1. They are tested against absolute paths, which are backslash-separated on
//    Windows. A pattern written as /backend\/.*/ works on macOS and Linux and
//    silently matches nothing here, letting the hot-reload loop come back.
//
// 2. They must be anchored to this project's root. An unanchored /[\\/]dist[\\/]/
//    also matches node_modules/react-native-web/dist/, and blocking that breaks
//    the web bundle with "Unable to resolve module
//    react-native-web/dist/exports/AppRegistry" — which reads like a broken
//    install, not a resolver rule.
const root = __dirname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sep = '[\\\\/]';

config.resolver.blockList = [
  // Generated web bundle output left in the project root.
  new RegExp(`^${root}${sep}index-[a-f0-9]+\\.js$`, 'i'),
  new RegExp(`^${root}${sep}\\.expo${sep}`, 'i'),
  new RegExp(`^${root}${sep}backend${sep}`, 'i'),
  new RegExp(`^${root}${sep}dist${sep}`, 'i'),
];

module.exports = config;
