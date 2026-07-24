import Foundation
import Security

struct Input: Decodable {
    let service: String
    let account: String
    let secret: String?
    let action: String?
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
let input = try JSONDecoder().decode(Input.self, from: inputData)
guard !input.service.isEmpty, !input.account.isEmpty else {
    throw NSError(domain: "KeychainInput", code: 1)
}

let query: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: input.service,
    kSecAttrAccount: input.account,
]
if input.action == "read" {
    var readQuery = query
    readQuery[kSecReturnData] = true
    readQuery[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(readQuery as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    FileHandle.standardOutput.write(data)
    exit(EXIT_SUCCESS)
}
guard let secret = input.secret, !secret.isEmpty else {
    throw NSError(domain: "KeychainInput", code: 2)
}
let secretData = Data(secret.utf8)
var currentApplication: SecTrustedApplication?
var securityApplication: SecTrustedApplication?
guard
    SecTrustedApplicationCreateFromPath(nil, &currentApplication) == errSecSuccess,
    SecTrustedApplicationCreateFromPath(
        "/usr/bin/security",
        &securityApplication
    ) == errSecSuccess,
    let currentApplication,
    let securityApplication
else {
    throw NSError(domain: "KeychainAccess", code: 1)
}
var access: SecAccess?
guard
    SecAccessCreate(
        input.service as CFString,
        [currentApplication, securityApplication] as CFArray,
        &access
    ) == errSecSuccess,
    let access
else {
    throw NSError(domain: "KeychainAccess", code: 2)
}

var item = query
item[kSecValueData] = secretData
item[kSecAttrAccess] = access
let writeStatus = SecItemAdd(item as CFDictionary, nil)
guard writeStatus == errSecSuccess else {
    throw NSError(domain: NSOSStatusErrorDomain, code: Int(writeStatus))
}

var verifyQuery = query
verifyQuery[kSecReturnData] = true
verifyQuery[kSecMatchLimit] = kSecMatchLimitOne
var verified: CFTypeRef?
let verifyStatus = SecItemCopyMatching(verifyQuery as CFDictionary, &verified)
guard
    verifyStatus == errSecSuccess,
    let stored = verified as? Data,
    stored == secretData
else {
    throw NSError(domain: NSOSStatusErrorDomain, code: Int(verifyStatus))
}
