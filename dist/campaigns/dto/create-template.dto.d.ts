export declare class CreateTemplateDto {
    name: string;
    channel: 'email' | 'whatsapp' | 'sms';
    subject?: string;
    body: string;
}
