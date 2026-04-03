import type { IncomingPacket } from "../../core/types/message";
import type { RobotDispatcher } from "../../dispatcher/impl/RobotDispatcher";

export type SensorInfoTab = "general" | "topics" | "pixhawk_gps" | "lidar" | "camera";

export interface SensorInfoTopicCatalogEntry {
  name: string;
  publisherCount: number;
  subscriberCount: number;
}

export interface SensorInfoState {
  activeTab: SensorInfoTab;
  open: boolean;
  intervals: Record<SensorInfoTab, number>;
  loading: Record<SensorInfoTab, boolean>;
  implemented: Record<SensorInfoTab, boolean>;
  errors: Record<SensorInfoTab, string>;
  payloads: Partial<Record<SensorInfoTab, IncomingPacket>>;
  topics: {
    search: string;
    selectedTopic: string;
    selectedType: string;
    pendingTopic: string;
    historyText: string;
    truncated: boolean;
    catalog: SensorInfoTopicCatalogEntry[];
  };
}

type Listener = (state: SensorInfoState) => void;

const DEFAULT_INTERVAL = 0.1;

function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL;
  return Math.min(5.0, Math.max(0.1, Math.round(value * 10) / 10));
}

function parseTab(value: unknown): SensorInfoTab | null {
  const tab = String(value ?? "");
  if (tab === "general" || tab === "topics" || tab === "pixhawk_gps" || tab === "lidar" || tab === "camera") {
    return tab;
  }
  return null;
}

function normalizeTopicHistoryText(snapshot: Record<string, unknown>, current: string): string {
  const direct = String(snapshot.history_text ?? "").trim();
  if (direct) return direct;
  const entries = Array.isArray(snapshot.history_entries) ? snapshot.history_entries : [];
  if (entries.length === 0) return current;
  return entries
    .map((entry) => {
      if (entry == null) return "";
      if (typeof entry === "string") return entry;
      if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
      if (typeof entry === "object") {
        try {
          return JSON.stringify(entry);
        } catch {
          return "";
        }
      }
      return "";
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

export class SensorInfoService {
  private readonly listeners = new Set<Listener>();
  private state: SensorInfoState = {
    activeTab: "general",
    open: false,
    intervals: {
      general: DEFAULT_INTERVAL,
      topics: DEFAULT_INTERVAL,
      pixhawk_gps: DEFAULT_INTERVAL,
      lidar: DEFAULT_INTERVAL,
      camera: DEFAULT_INTERVAL
    },
    loading: {
      general: false,
      topics: false,
      pixhawk_gps: false,
      lidar: false,
      camera: false
    },
    implemented: {
      general: true,
      topics: true,
      pixhawk_gps: true,
      lidar: false,
      camera: false
    },
    errors: {
      general: "",
      topics: "",
      pixhawk_gps: "",
      lidar: "",
      camera: ""
    },
    payloads: {},
    topics: {
      search: "",
      selectedTopic: "",
      selectedType: "",
      pendingTopic: "",
      historyText: "",
      truncated: false,
      catalog: []
    }
  };

  constructor(private readonly robotDispatcher: RobotDispatcher) {
    this.robotDispatcher.subscribeSensorInfo((message) => {
      this.applyIncoming(message);
    });
  }

  getState(): SensorInfoState {
    return {
      ...this.state,
      intervals: { ...this.state.intervals },
      loading: { ...this.state.loading },
      implemented: { ...this.state.implemented },
      errors: { ...this.state.errors },
      payloads: { ...this.state.payloads },
      topics: {
        ...this.state.topics,
        catalog: this.state.topics.catalog.map((entry) => ({ ...entry }))
      }
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async open(): Promise<void> {
    this.state = {
      ...this.state,
      open: true
    };
    this.emit();
    await this.syncActiveTab();
  }

  async close(): Promise<void> {
    this.state = {
      ...this.state,
      open: false,
      loading: {
        general: false,
        topics: false,
        pixhawk_gps: false,
        lidar: false,
        camera: false
      }
    };
    this.emit();
    await this.robotDispatcher.requestSensorInfoView({
      enabled: false,
      tab: null,
      intervalS: clampInterval(this.state.intervals[this.state.activeTab]),
      topicName: null
    });
  }

  async setActiveTab(tab: SensorInfoTab): Promise<void> {
    this.state = {
      ...this.state,
      activeTab: tab
    };
    this.emit();
    if (this.state.open) {
      await this.syncActiveTab();
    }
  }

  async setInterval(tab: SensorInfoTab, value: number): Promise<void> {
    const next = clampInterval(value);
    this.state = {
      ...this.state,
      intervals: {
        ...this.state.intervals,
        [tab]: next
      }
    };
    this.emit();
    if (this.state.open && this.state.activeTab === tab) {
      await this.syncActiveTab();
    }
  }

  setTopicSearch(value: string): void {
    this.state = {
      ...this.state,
      topics: {
        ...this.state.topics,
        search: value
      }
    };
    this.emit();
  }

  async selectTopic(name: string): Promise<void> {
    this.state = {
      ...this.state,
      topics: {
        ...this.state.topics,
        pendingTopic: name,
        selectedTopic: name,
        selectedType: "",
        historyText: "",
        truncated: false
      },
      payloads: {
        ...this.state.payloads,
        topics: undefined
      }
    };
    this.emit();
    if (this.state.open && this.state.activeTab === "topics") {
      await this.syncActiveTab();
    }
  }

  private async syncActiveTab(): Promise<void> {
    const tab = this.state.activeTab;
    this.state = {
      ...this.state,
      loading: {
        ...this.state.loading,
        [tab]: true
      },
      errors: {
        ...this.state.errors,
        [tab]: ""
      }
    };
    this.emit();

    await this.robotDispatcher.requestSensorInfoView({
      enabled: true,
      tab,
      intervalS: this.state.intervals[tab],
      topicName: tab === "topics" ? this.state.topics.selectedTopic || null : null
    });
  }

  private applyIncoming(message: IncomingPacket): void {
    const tab = parseTab(message.tab);
    if (!tab) return;

    const loading = {
      ...this.state.loading,
      [tab]: false
    };
    const errors = {
      ...this.state.errors,
      [tab]: message.ok === false ? String(message.error ?? "sensor info error") : ""
    };
    const implemented = {
      ...this.state.implemented,
      [tab]: message.implemented === true
    };
    const payloads = {
      ...this.state.payloads,
      [tab]: message
    };

    let topics = this.state.topics;
    if (tab === "topics") {
      const snapshot = (message.snapshot ?? {}) as Record<string, unknown>;
      const catalog = Array.isArray(snapshot.topics_catalog)
        ? snapshot.topics_catalog
            .map((entry) => {
              if (!entry || typeof entry !== "object") return null;
              const value = entry as Record<string, unknown>;
              const name = String(value.name ?? "");
              if (!name) return null;
              return {
                name,
                publisherCount: Number(value.publisher_count ?? 0),
                subscriberCount: Number(value.subscriber_count ?? 0)
              };
            })
            .filter((entry): entry is SensorInfoTopicCatalogEntry => entry !== null)
        : [];
      topics = {
        ...topics,
        selectedTopic: String(snapshot.selected_topic ?? topics.selectedTopic ?? ""),
        selectedType: String(snapshot.selected_type ?? topics.selectedType ?? ""),
        historyText: normalizeTopicHistoryText(snapshot, topics.historyText),
        truncated: snapshot.truncated === true,
        pendingTopic:
          String(snapshot.selected_topic ?? "") === topics.pendingTopic || message.ok === false ? "" : topics.pendingTopic,
        catalog
      };
    }

    if (typeof message.interval_s === "number") {
      const interval = clampInterval(Number(message.interval_s));
      this.state = {
        ...this.state,
        intervals: {
          ...this.state.intervals,
          [tab]: interval
        },
        loading,
        errors,
        implemented,
        payloads,
        topics
      };
    } else {
      this.state = {
        ...this.state,
        loading,
        errors,
        implemented,
        payloads,
        topics
      };
    }
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
