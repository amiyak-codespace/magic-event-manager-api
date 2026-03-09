import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateEventDto } from './dto/create-event.dto';

interface EventEntity {
  id: string;
  name: string;
  date: string;
}

@Injectable()
export class EventsService {
  private events: EventEntity[] = [];

  list() {
    return this.events;
  }

  create(dto: CreateEventDto) {
    const e: EventEntity = { id: String(this.events.length + 1), name: dto.name, date: dto.date };
    this.events.push(e);
    return e;
  }

  get(id: string) {
    const e = this.events.find((x) => x.id === id);
    if (!e) throw new NotFoundException('Event not found');
    return e;
  }
}
