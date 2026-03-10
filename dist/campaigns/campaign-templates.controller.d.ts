import { CampaignTemplatesService } from './campaign-templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
export declare class CampaignTemplatesController {
    private readonly svc;
    constructor(svc: CampaignTemplatesService);
    list(): Promise<import("./entities/template.entity").CampaignTemplate[]>;
    create(dto: CreateTemplateDto): Promise<import("./entities/template.entity").CampaignTemplate>;
    get(id: string): Promise<import("./entities/template.entity").CampaignTemplate>;
    update(id: string, dto: UpdateTemplateDto): Promise<import("./entities/template.entity").CampaignTemplate>;
    remove(id: string): Promise<void>;
    preview(id: string, variables?: Record<string, any>, bodyOnly?: string): Promise<any>;
}
