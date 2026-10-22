import { ApiProperty } from '@nestjs/swagger';

/** Documentation shape only (what Swagger shows). The service returns a plain object with the same fields. */
export class CheckoutResponseDto {
  @ApiProperty({ example: 'https://secure.payu.in/_payment', description: 'Where the browser posts the form. Staging answers with the PayU test address.' })
  gatewayUrl!: string;

  @ApiProperty({ enum: ['POST'] })
  method!: 'POST';

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Every field the browser must post to PayU as a form (key, txnid, amount, productinfo, firstname, email, phone, surl, furl, curl, udf1, hash). ' +
      'The merchant key is public by design; the salt never leaves the server. The details are the ones typed on the booking, not the account.',
    example: { key: 'merchantKey', txnid: 'EDTX01JBTESTTXN000000001', amount: '2499.00', productinfo: 'One-Time Consult', firstname: 'Priya', email: 'priya@example.com', phone: '9876543210', udf1: 'ED-7K3QXM', hash: '…' },
  })
  fields!: Record<string, string>;
}
