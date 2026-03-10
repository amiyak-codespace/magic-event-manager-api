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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CampaignTemplatesController = void 0;
const common_1 = require("@nestjs/common");
const campaign_templates_service_1 = require("./campaign-templates.service");
const create_template_dto_1 = require("./dto/create-template.dto");
const update_template_dto_1 = require("./dto/update-template.dto");
let CampaignTemplatesController = class CampaignTemplatesController {
    constructor(svc) {
        this.svc = svc;
    }
    list() {
        return this.svc.list();
    }
    create(dto) {
        return this.svc.create(dto);
    }
    get(id) {
        return this.svc.findOne(id);
    }
    update(id, dto) {
        return this.svc.update(id, dto);
    }
    remove(id) {
        return this.svc.remove(id);
    }
    async preview(id, variables = {}, bodyOnly) {
        const tpl = await this.svc.findOne(id);
        const renderedBody = this.svc.render(tpl.body, variables || {});
        const payload = { channel: tpl.channel, body: renderedBody };
        if (tpl.channel === 'email') {
            payload.subject = this.svc.render(tpl.subject ?? '', variables || {});
        }
        if (bodyOnly === 'true')
            return payload.body;
        return payload;
    }
};
exports.CampaignTemplatesController = CampaignTemplatesController;
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], CampaignTemplatesController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [create_template_dto_1.CreateTemplateDto]),
    __metadata("design:returntype", void 0)
], CampaignTemplatesController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CampaignTemplatesController.prototype, "get", null);
__decorate([
    (0, common_1.Put)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_template_dto_1.UpdateTemplateDto]),
    __metadata("design:returntype", void 0)
], CampaignTemplatesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], CampaignTemplatesController.prototype, "remove", null);
__decorate([
    (0, common_1.Post)(':id/preview'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)('variables')),
    __param(2, (0, common_1.Query)('bodyOnly')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, String]),
    __metadata("design:returntype", Promise)
], CampaignTemplatesController.prototype, "preview", null);
exports.CampaignTemplatesController = CampaignTemplatesController = __decorate([
    (0, common_1.Controller)('campaign-templates'),
    __metadata("design:paramtypes", [campaign_templates_service_1.CampaignTemplatesService])
], CampaignTemplatesController);
//# sourceMappingURL=campaign-templates.controller.js.map