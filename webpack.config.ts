import type { Configuration } from 'webpack';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import { mergeWithRules } from 'webpack-merge';

import grafanaConfig, { type Env } from './.config/webpack/webpack.config.ts';

const config = async (env: Env): Promise<Configuration> => {
  const baseConfig = await grafanaConfig(env);

  return mergeWithRules({
    module: {
      rules: {
        test: 'match',
        use: 'merge',
      },
    },
  })(baseConfig, {
    externals: ['@grafana/scenes'],
    module: {
      rules: [
        {
          test: /\.[tj]sx?$/,
          use: {
            loader: 'swc-loader',
            options: {
              jsc: {
                transform: {
                  react: {
                    runtime: 'automatic',
                  },
                },
              },
            },
          },
        },
      ],
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [{ from: '../NOTICE', to: '.' }],
      }),
    ],
  });
};

export default config;
