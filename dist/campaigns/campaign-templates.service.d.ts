import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { CampaignTemplate } from './entities/template.entity';
export declare class CampaignTemplatesService {
    private readonly storageFile;
    constructor();
    private readAll;
    private writeAll;
    list(): Promise<CampaignTemplate[]>;
    create(dto: CreateTemplateDto): Promise<CampaignTemplate>;
    findOne(id: string): Promise<CampaignTemplate>;
    update(id: string, dto: UpdateTemplateDto): Promise<CampaignTemplate>;
    remove(id: string): Promise<void>;
    render(body: string, variables: Record<string, any>): string;
}
