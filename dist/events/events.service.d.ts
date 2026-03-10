import { CreateEventDto } from './dto/create-event.dto';
import { EventEntity } from './entities/event.entity';
export declare class EventsService {
    private events;
    list(): EventEntity[];
    create(dto: CreateEventDto): EventEntity;
    get(id: string): EventEntity;
}
