module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Must stay last in the plugin list.
    plugins: ['react-native-reanimated/plugin'],
  };
};
