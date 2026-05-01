abstract final class PairingContract {
  static const pairingCodesCollection = 'pairing_codes';
  static const pairingsCollection = 'pairings';

  static const createdAtField = 'createdAt';
  static const updatedAtField = 'updatedAt';
  static const statusField = 'status';
  static const pubkeysField = 'pubkeys';
  static const activeSessionIdField = 'activeSessionId';
  static const selectedModeField = 'selectedMode';
  static const selectedByField = 'selectedBy';
  static const subscriptionMembersField = 'subscriptionMembers';

  static const selectingStatus = 'selecting';
  static const activeStatus = 'active';
  static const endedStatus = 'ended';
  static const resetStatus = 'reset';
  static const confirmedStatus = 'confirmed';
  static const cancelledStatus = 'cancelled';
}
