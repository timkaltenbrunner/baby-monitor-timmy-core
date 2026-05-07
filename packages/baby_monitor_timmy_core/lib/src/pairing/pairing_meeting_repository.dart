import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';

import 'pairing_contract.dart';

@immutable
class PairingMeetingData {
  final bool exists;
  final String? status;
  final Map<String, String> pubkeys;
  final String? peerType;
  final String? webUid;
  final String? webSessionId;

  const PairingMeetingData({
    required this.exists,
    required this.status,
    required this.pubkeys,
    this.peerType,
    this.webUid,
    this.webSessionId,
  });

  factory PairingMeetingData.fromSnapshot(
    DocumentSnapshot<Map<String, dynamic>> snapshot,
  ) {
    final data = snapshot.data();
    final rawPubkeys = Map<String, dynamic>.from(
      data?[PairingContract.pubkeysField] as Map? ?? const {},
    );
    return PairingMeetingData(
      exists: snapshot.exists,
      status: data?[PairingContract.statusField] as String?,
      pubkeys: rawPubkeys.map(
        (key, value) => MapEntry(key, value.toString()),
      ),
      peerType: data?[PairingContract.peerTypeField] as String?,
      webUid: data?[PairingContract.webUidField] as String?,
      webSessionId: data?[PairingContract.webSessionIdField] as String?,
    );
  }

  bool get isCancelled => status == PairingContract.cancelledStatus;

  String? remotePublicKeyFor(String uid) {
    for (final entry in pubkeys.entries) {
      if (entry.key != uid) {
        return entry.value;
      }
    }
    return null;
  }
}

class PairingMeetingRepository {
  final FirebaseFirestore _db;

  PairingMeetingRepository({FirebaseFirestore? firestore})
      : _db = firestore ?? FirebaseFirestore.instance;

  DocumentReference<Map<String, dynamic>> meetingRef(String meetingKey) =>
      _db.collection(PairingContract.pairingCodesCollection).doc(meetingKey);

  Future<void> createMeetingPoint({
    required String meetingKey,
    required String uid,
    required String publicKey,
    String? peerType,
    String? webSessionId,
  }) {
    final data = createMeetingPointData(
      uid: uid,
      publicKey: publicKey,
      peerType: peerType,
      webSessionId: webSessionId,
    );
    return meetingRef(meetingKey).set(data);
  }

  static Map<String, dynamic> createMeetingPointData({
    required String uid,
    required String publicKey,
    String? peerType,
    String? webSessionId,
  }) {
    final data = <String, dynamic>{
      PairingContract.createdAtField: FieldValue.serverTimestamp(),
      PairingContract.pubkeysField: {uid: publicKey},
    };
    if (peerType != null) {
      data[PairingContract.peerTypeField] = peerType;
    }
    if (webSessionId != null) {
      data[PairingContract.webUidField] = uid;
      data[PairingContract.webSessionIdField] = webSessionId;
    }
    return data;
  }

  Stream<PairingMeetingData> watchMeetingPoint(String meetingKey) {
    return meetingRef(meetingKey)
        .snapshots()
        .map(PairingMeetingData.fromSnapshot);
  }

  Future<PairingMeetingData> fetchMeetingPoint(
    String meetingKey, {
    int attempts = 1,
    Duration retryDelay = const Duration(milliseconds: 500),
  }) async {
    late PairingMeetingData meeting;
    for (int attempt = 1; attempt <= attempts; attempt++) {
      final snapshot = await meetingRef(meetingKey).get();
      meeting = PairingMeetingData.fromSnapshot(snapshot);
      if (meeting.exists || attempt == attempts) {
        return meeting;
      }
      await Future.delayed(retryDelay);
    }
    return meeting;
  }

  Future<void> addPublicKey({
    required String meetingKey,
    required String uid,
    required String publicKey,
  }) {
    return meetingRef(meetingKey).set({
      PairingContract.pubkeysField: {uid: publicKey},
    }, SetOptions(merge: true));
  }

  Future<void> updateStatus(String meetingKey, String status) {
    return meetingRef(meetingKey).update({
      PairingContract.statusField: status,
    });
  }

  Future<void> deleteMeetingPoint(String meetingKey) {
    return meetingRef(meetingKey).delete();
  }
}
