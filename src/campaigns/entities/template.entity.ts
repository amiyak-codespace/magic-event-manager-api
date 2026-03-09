export interface CampaignTemplate {
  id: string;
  name: string;
  channel: 'email' | 'whatsapp' | 'sms';
  subject?: string;
  body: string;
  createdAt: string; // ISO date
  updatedAt: string; // ISO date
}

