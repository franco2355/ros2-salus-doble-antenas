export interface EnvConfig {
  appName: string;
  wsUrl: string;
  rosbridgeUrl: string;
  httpBaseUrl: string;
  googleMapsApiKey: string;
}

export function loadEnvConfig(env: ImportMetaEnv = import.meta.env): EnvConfig {
  return {
    appName: env.VITE_APP_NAME ?? "Cockpit Desktop",
    wsUrl: env.VITE_WS_URL ?? "ws://localhost:8766",
    rosbridgeUrl: env.VITE_ROSBRIDGE_URL ?? "ws://localhost:9090",
    httpBaseUrl: env.VITE_HTTP_BASE_URL ?? "http://localhost:8080",
    googleMapsApiKey: env.VITE_GOOGLE_MAPS_API_KEY ?? ""
  };
}

