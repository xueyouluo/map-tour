export interface SettingField {
  key: string;
  label: string;
  value: string;
  secret: boolean;
  configured: boolean;
  group: 'text' | 'map' | 'video' | 'users';
  placeholder?: string;
  choices?: string[];
}

export interface ServiceSettings {
  fields: SettingField[];
  status: {
    textReady: boolean;
    imageReady: boolean;
    mapReady: boolean;
    videoReady: boolean;
    videoReason?: string;
    musicCount: number;
  };
  storage: string;
}
