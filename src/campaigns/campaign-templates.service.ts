import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { CampaignTemplate } from './entities/template.entity';

@Injectable()
export class CampaignTemplatesService {
  private readonly storageFile: string;

  constructor() {
    const configured = process.env.TEMPLATES_FILE;
    this.storageFile = resolve(process.cwd(), configured ?? 'data/templates.json');
  }

  private async readAll(): Promise<CampaignTemplate[]> {
    try {
      const data = await fs.readFile(this.storageFile, 'utf8');
      return JSON.parse(data) as CampaignTemplate[];
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writeAll(list: CampaignTemplate[]): Promise<void> {
    await fs.mkdir(dirname(this.storageFile), { recursive: true });
    await fs.writeFile(this.storageFile, JSON.stringify(list, null, 2), 'utf8');
  }

  async list(): Promise<CampaignTemplate[]> {
    return this.readAll();
  }

  async create(dto: CreateTemplateDto): Promise<CampaignTemplate> {
    const now = new Date().toISOString();
    const item: CampaignTemplate = {
      id: randomUUID(),
      name: dto.name,
      channel: dto.channel,
      subject: dto.subject,
      body: dto.body,
      createdAt: now,
      updatedAt: now,
    };
    const all = await this.readAll();
    all.push(item);
    await this.writeAll(all);
    return item;
  }

  async findOne(id: string): Promise<CampaignTemplate> {
    const all = await this.readAll();
    const found = all.find((t) => t.id === id);
    if (!found) throw new NotFoundException('Template not found');
    return found;
  }

  async update(id: string, dto: UpdateTemplateDto): Promise<CampaignTemplate> {
    const all = await this.readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx === -1) throw new NotFoundException('Template not found');
    const prev = all[idx];
    const next: CampaignTemplate = {
      ...prev,
      ...dto,
      updatedAt: new Date().toISOString(),
    };
    all[idx] = next;
    await this.writeAll(all);
    return next;
  }

  async remove(id: string): Promise<void> {
    const all = await this.readAll();
    const next = all.filter((t) => t.id !== id);
    if (next.length === all.length) throw new NotFoundException('Template not found');
    await this.writeAll(next);
  }

  render(body: string, variables: Record<string, any>): string {
    return body.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, key: string) => {
      const value = key.split('.').reduce<any>((acc, k) => (acc ? acc[k] : undefined), variables);
      return value == null ? '' : String(value);
    });
  }
}

