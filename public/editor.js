export class SaveState {
  constructor(){this.revision=0;this.pending=false;}
  changed(){this.revision++;}
  begin(eventId){if(this.pending)return null;this.pending=true;return {eventId,revision:this.revision};}
  finish(ticket,eventId){this.pending=false;return ticket.eventId===eventId&&ticket.revision===this.revision;}
}
