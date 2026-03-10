import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { EventEntity } from './entities/event.entity';
export declare class EventsController {
    private readonly svc;
    constructor(svc: EventsService);
    list(): EventEntity[];
    create(dto: CreateEventDto): EventEntity;
    get(id: string): EventEntity;
}
