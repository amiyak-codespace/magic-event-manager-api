"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CampaignTemplatesService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
let CampaignTemplatesService = class CampaignTemplatesService {
    constructor() {
        const configured = process.env.TEMPLATES_FILE;
        this.storageFile = (0, path_1.resolve)(process.cwd(), configured ?? 'data/templates.json');
    }
    async readAll() {
        try {
            const data = await fs_1.promises.readFile(this.storageFile, 'utf8');
            return JSON.parse(data);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
    }
    async writeAll(list) {
        await fs_1.promises.mkdir((0, path_1.dirname)(this.storageFile), { recursive: true });
        await fs_1.promises.writeFile(this.storageFile, JSON.stringify(list, null, 2), 'utf8');
    }
    async list() {
        return this.readAll();
    }
    async create(dto) {
        const now = new Date().toISOString();
        const item = {
            id: (0, crypto_1.randomUUID)(),
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
    async findOne(id) {
        const all = await this.readAll();
        const found = all.find((t) => t.id === id);
        if (!found)
            throw new common_1.NotFoundException('Template not found');
        return found;
    }
    async update(id, dto) {
        const all = await this.readAll();
        const idx = all.findIndex((t) => t.id === id);
        if (idx === -1)
            throw new common_1.NotFoundException('Template not found');
        const prev = all[idx];
        const next = {
            ...prev,
            ...dto,
            updatedAt: new Date().toISOString(),
        };
        all[idx] = next;
        await this.writeAll(all);
        return next;
    }
    async remove(id) {
        const all = await this.readAll();
        const next = all.filter((t) => t.id !== id);
        if (next.length === all.length)
            throw new common_1.NotFoundException('Template not found');
        await this.writeAll(next);
    }
    render(body, variables) {
        return body.replace(/\{\{\s*([a-zA-Z0-9_\.]+)\s*\}\}/g, (_, key) => {
            const value = key.split('.').reduce((acc, k) => (acc ? acc[k] : undefined), variables);
            return value == null ? '' : String(value);
        });
    }
};
exports.CampaignTemplatesService = CampaignTemplatesService;
exports.CampaignTemplatesService = CampaignTemplatesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], CampaignTemplatesService);
//# sourceMappingURL=campaign-templates.service.js.map