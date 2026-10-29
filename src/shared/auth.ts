export interface UserAccount {
  id: string;
  username: string;
  displayName: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  itineraryLimit: number;
  itineraryCount: number;
  createdAt: string;
}
export interface AuthSession {
  user: UserAccount | null;
  registrationEnabled: boolean;
  setupAvailable: boolean;
}
export function canCreateItinerary(user: UserAccount): boolean {
  return user.role === 'admin' || user.itineraryCount < user.itineraryLimit;
}
