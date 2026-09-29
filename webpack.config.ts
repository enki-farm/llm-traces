import path from 'path';
import CopyWebpackPlugin from 'copy-webpack-plugin';

export default (env: Record<string, boolean> = {}) => ({
  mode: env.production ? 'production' : 'development',
  devtool: env.production ? false : 'source-map',

  entry: { module: './module.tsx' },

  output: {
    clean: true,
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'amd',
    publicPath: 'public/plugins/llm-traces-app/',
  },

  // These are provided by Grafana at runtime via AMD — do NOT bundle them.
  externals: [
    'lodash',
    'react',
    'react-dom',
    '@emotion/css',
    '@grafana/data',
    '@grafana/runtime',
    '@grafana/ui',
    '@grafana/scenes',
    /^@grafana\/.*/,
    /^rxjs(\/.+)?$/,
  ],

  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            configFile: 'tsconfig.standalone.json',
          },
        },
      },
      {
        test: /\.css$/,
        exclude: /node_modules/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },

  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'public', to: '.' },
        { from: 'plugin.json', to: '.' },
      ],
    }),
  ],
});
