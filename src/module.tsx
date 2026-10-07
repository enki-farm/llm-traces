import { AppPlugin } from '@grafana/data';

import { TraceExplorer } from './pages/TraceExplorer';

import pluginJson from './plugin.json';

export { pluginJson };

export const plugin = new AppPlugin<Record<string, never>>().setRootPage(TraceExplorer);