import { IGatewayAdapter } from './gateway.interface';
import { StripeAdapter } from './stripe.adapter';
import { RazorpayAdapter } from './razorpay.adapter';
import { PayUAdapter } from './payu.adapter';
import { UPIAdapter } from './upi.adapter';

export class GatewayFactory {
  private static adapters: Record<string, IGatewayAdapter> = {
    stripe: new StripeAdapter(),
    razorpay: new RazorpayAdapter(),
    payu: new PayUAdapter(),
    upi: new UPIAdapter(),
  };

  /**
   * Resolves and returns the gateway adapter instance for the given name.
   */
  public static getAdapter(name: string): IGatewayAdapter {
    const adapter = this.adapters[name.toLowerCase()];
    if (!adapter) {
      throw new Error(`Unsupported gateway adapter name: ${name}`);
    }
    return adapter;
  }
}
