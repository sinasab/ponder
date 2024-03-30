import { createConfig } from "@ponder/core";
import { http } from "viem";

import { foundry } from "viem/chains";
import { counterABI } from "../abis/Counter";

export default createConfig({
  networks: {
    anvil: {
      chain: foundry,
      transport: http("http://127.0.0.1:8545"),
    },
  },
  contracts: {
    Counter: {
      network: "anvil",
      abi: counterABI,
      address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      startBlock: 0,
    },
  },
});
