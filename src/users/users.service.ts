import { Injectable } from '@nestjs/common';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  private readonly users: User[] = [
    { id: '1', email: 'demo@example.com', name: 'Demo User' },
  ];

  findById(id: string) {
    return this.users.find((u) => u.id === id) || null;
  }
}
