import mongoose from 'mongoose';

const CallHistorySchema = new mongoose.Schema({
  callerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Initiator
  calleeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // For 1:1 calls
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' }, // For group calls
  callType: { type: String, enum: ['audio', 'video'], required: true },
  status: { 
    type: String, 
    enum: ['initiated', 'ringing', 'accepted', 'rejected', 'missed', 'ended'], 
    required: true 
  },
  duration: { type: Number, default: 0 }, // Seconds
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // For group calls
}, { timestamps: true });

// Indexes for fast queries
CallHistorySchema.index({ callerId: 1, startTime: -1 });
CallHistorySchema.index({ calleeId: 1, startTime: -1 });
CallHistorySchema.index({ groupId: 1, startTime: -1 });
CallHistorySchema.index({ participants: 1, startTime: -1 });

export default mongoose.model('CallHistory', CallHistorySchema);