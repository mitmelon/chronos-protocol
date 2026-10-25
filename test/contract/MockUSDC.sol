// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// Test token: 6 decimals, open mint, and an address blocklist (like real USDC) to prove one bad address can't block a batch.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;
    constructor() ERC20("Mock USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function _update(address from, address to, uint256 v) internal override { require(!blocked[to], "blocked"); super._update(from, to, v); }
}
